import browser from "webextension-polyfill";

const action = browser.action || (browser as any).browserAction;

// ---------------------------------------------------------------------------
// Summary session management
// Keyed by page URL so that navigating to a different page in the same tab
// correctly starts a fresh session instead of reusing a stale one.
// ---------------------------------------------------------------------------
interface SummarySession {
    ports: Set<browser.Runtime.Port>;
    messages: any[];   // full message history for replay
    done: boolean;
}

/** pageUrl → session */
const sessions = new Map<string, SummarySession>();

// ---------------------------------------------------------------------------
// Detached window tracking
// Ensures only one detached window exists per page URL.
// ---------------------------------------------------------------------------
/** pageUrl → windowId of the currently open detached popup */
const detachedWindows = new Map<string, number>();

browser.windows.onRemoved.addListener((windowId: number) => {
    for (const [url, wId] of detachedWindows) {
        if (wId === windowId) {
            detachedWindows.delete(url);
            break;
        }
    }
});

// ---------------------------------------------------------------------------
// Dynamic icon switching (dark / light mode)
// ---------------------------------------------------------------------------
function updateIcon(isDark: boolean) {
    if (!action) return;
    const suffix = isDark ? '-dark' : '';
    const iconPath: Record<string, string> = {
        '16': `icon16${suffix}.png`,
        '32': `icon32${suffix}.png`,
        '48': `icon48${suffix}.png`,
        '128': `icon128${suffix}.png`,
    };
    action.setIcon({ path: iconPath }).catch(() => {
        // Ignore — Firefox handles this via theme_icons in the manifest
    });
}

try {
    const mql = matchMedia('(prefers-color-scheme: dark)');
    updateIcon(mql.matches);
    mql.addEventListener('change', (e) => updateIcon(e.matches));
} catch {
    // matchMedia may not be available in older service workers
}

// ---------------------------------------------------------------------------
// Message handler: OPEN_DETACHED
// Sent by popup.ts when the attached popup window is closing and there is
// content worth preserving.
// ---------------------------------------------------------------------------
browser.runtime.onMessage.addListener(async (msg: any) => {
    if (msg.action === 'OPEN_DETACHED' && msg.url) {
        const pageUrl: string = msg.url;

        // If a detached window for this URL is already open, just focus it
        if (detachedWindows.has(pageUrl)) {
            const existingId = detachedWindows.get(pageUrl)!;
            try {
                await browser.windows.update(existingId, { focused: true });
                return; // done — no duplicate
            } catch {
                // Window was closed externally without firing onRemoved properly
                detachedWindows.delete(pageUrl);
            }
        }

        // No existing window — create one and track it
        const popupUrl = browser.runtime.getURL(
            `popup.html?detached=1&url=${encodeURIComponent(pageUrl)}`
        );
        try {
            const win = await (browser.windows as any).create({
                url: popupUrl,
                type: 'popup',
                width: 420,
                height: 580,
                focused: true,
            });
            if (win?.id != null) {
                detachedWindows.set(pageUrl, win.id);
            }
        } catch (e) {
            console.error('Failed to open detached window:', e);
        }
    }
});

// ---------------------------------------------------------------------------
// Port handler: START_SUMMARY
// ---------------------------------------------------------------------------
browser.runtime.onConnect.addListener(port => {
    port.onMessage.addListener(async (msg: any) => {
        if (msg.action !== 'START_SUMMARY') return;

        const sessionKey: string | undefined = msg.url; // page URL as session key

        // ---- Session reuse ----
        if (sessionKey && sessions.has(sessionKey)) {
            const session = sessions.get(sessionKey)!;

            // Replay everything the port has missed
            for (const buffered of session.messages) {
                try { port.postMessage(buffered); } catch { /* port may have closed */ }
            }

            if (!session.done) {
                // Subscribe to future messages
                session.ports.add(port);
                port.onDisconnect.addListener(() => session.ports.delete(port));
            }
            // Session is already done → replay was all that was needed
            return;
        }

        // Popup sent '__REUSE__' expecting a session to exist, but none was found.
        // Tell the popup to fall back to full text extraction.
        if (msg.text === '__REUSE__') {
            try { port.postMessage({ __sentinel: 'NO_SESSION' }); } catch { /* */ }
            return;
        }

        // ---- New session ----
        await handleStreamSummary(msg.text, msg.language || 'en', port, sessionKey);
    });
});

// ---------------------------------------------------------------------------
// Core streaming logic
// ---------------------------------------------------------------------------
async function handleStreamSummary(
    textContent: string,
    language: string,
    port: browser.Runtime.Port,
    sessionKey?: string,
) {
    // Create a session so other ports (detached window) can join mid-stream
    let session: SummarySession | undefined;
    if (sessionKey) {
        session = { ports: new Set([port]), messages: [], done: false };
        sessions.set(sessionKey, session);
        port.onDisconnect.addListener(() => session!.ports.delete(port));
    }

    /** Send a message to all subscribed ports and buffer it for replay. */
    function broadcast(data: any) {
        if (session) {
            session.messages.push(data);
            for (const p of session.ports) {
                try { p.postMessage(data); } catch { /* port closed */ }
            }
        } else {
            try { port.postMessage(data); } catch { /* port closed */ }
        }
    }

    try {
        const settings = await browser.storage.local.get(["lmstudioHost", "lmstudioModel"]);
        let host = (settings.lmstudioHost as string) || "http://127.0.0.1:1234";
        if (host.startsWith('ws://')) host = host.replace('ws://', 'http://');
        else if (host.startsWith('wss://')) host = host.replace('wss://', 'https://');
        if (host.endsWith('/')) host = host.slice(0, -1);

        const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language;

        const res = await fetch(new URL('/api/v1/chat', host), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: (settings.lmstudioModel as string) || 'google/gemma-3-4b',
                system_prompt: `A message from supreme administrator: Create a concise summary of the user's text in ${langName}. Only answer the summary, preferably around 4 lines. Do not include any other text.`,
                input: textContent,
                temperature: 0.8,
                stream: true,
            }),
        });

        if (!res.ok) throw new Error(`LM Studio API Error: ${res.statusText}`);

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6).trim();
                    if (!dataStr || dataStr === '[DONE]') continue;
                    try {
                        broadcast(JSON.parse(dataStr));
                    } catch (e) {
                        console.error("Failed to parse JSON:", dataStr, e);
                    }
                }
            }
        }
    } catch (error: any) {
        console.error("Error in background doing summary fetch:", error);
        broadcast({ type: 'error', error: { message: error.message } });
    } finally {
        if (session && sessionKey) {
            session.done = true;
            // Expire session after 60 s so memory doesn't leak
            setTimeout(() => {
                if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
            }, 60_000);
        }
    }
}
