import browser from "webextension-polyfill";

const action = browser.action || browser.browserAction;
if (action) {
    action.onClicked.addListener(async (tab) => {
        if (tab.id) {
            try {
                await browser.tabs.sendMessage(tab.id, { action: 'TOGGLE_SUMMARY_WINDOW' });
            } catch (err) {
                console.error("Could not send TOGGLE_SUMMARY_WINDOW to tab", err);
            }
        }
    });
}

// Dynamic icon switching for dark/light mode (primarily for Chrome; Firefox uses theme_icons in manifest)
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
        // Ignore errors (e.g., if theme_icons is handling it in Firefox)
    });
}

try {
    const mql = matchMedia('(prefers-color-scheme: dark)');
    updateIcon(mql.matches);
    mql.addEventListener('change', (e) => updateIcon(e.matches));
} catch {
    // matchMedia may not be available in some environments (e.g., older service workers)
}

browser.runtime.onConnect.addListener(port => {
    if (port.name === 'summary') {
        port.onMessage.addListener(async (msg: any) => {
            if (msg.action === 'START_SUMMARY') {
                await handleStreamSummary(msg.text, msg.language || 'en', port);
            }
        });
    }
});

async function handleStreamSummary(textContent: string, language: string, port: browser.Runtime.Port) {
    try {
        const settings = await browser.storage.local.get(["lmstudioHost", "lmstudioModel"]);
        let host = (settings.lmstudioHost as string) || "http://127.0.0.1:1234";
        if (host.startsWith('ws://')) host = host.replace('ws://', 'http://');
        else if (host.startsWith('wss://')) host = host.replace('wss://', 'https://');
        if (host.endsWith('/')) {
            host = host.slice(0, -1);
        }

        const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(language) || language;

        const res = await fetch(new URL('/api/v1/chat', host), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: (settings.lmstudioModel as string) || 'google/gemma-3-4b',
                system_prompt: `A message from supreme administrator: Create a concise summary of the user's text in ${langName}. Only answer the summary, preferably around 4 lines. Do not include any other text.`,
                input: textContent,
                temperature: 0.8,
                stream: true,
            })
        });

        if (!res.ok) {
            throw new Error(`LM Studio API Error: ${res.statusText}`);
        }

        const reader = res.body?.getReader();
        if (!reader) {
            throw new Error("No response body");
        }
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
                        const data = JSON.parse(dataStr);
                        port.postMessage(data);
                    } catch (e) {
                        console.error("Failed to parse JSON:", dataStr, e);
                    }
                }
            }
        }
    } catch (error: any) {
        console.error("Error in background doing summary fetch:", error);
        port.postMessage({ type: 'error', error: { message: error.message } });
    }
}
