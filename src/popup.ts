import browser from "webextension-polyfill";

const statusEl       = document.getElementById('status-text')  as HTMLDivElement;
const summaryEl      = document.getElementById('summary-text') as HTMLDivElement;
const modelBadgeEl   = document.getElementById('model-badge')  as HTMLSpanElement;
const detachBtn      = document.getElementById('detach-btn')   as HTMLButtonElement;
const retryBtn       = document.getElementById('retry-btn')    as HTMLButtonElement;
const openSettingsBtn = document.getElementById('open-settings') as HTMLButtonElement;

// ---------------------------------------------------------------------------
// Determine context (attached popup vs. detached window)
// ---------------------------------------------------------------------------
const urlParams      = new URLSearchParams(window.location.search);
const isDetached     = urlParams.get('detached') === '1';
/** Page URL passed via query param when opening a detached window */
const detachedPageUrl = urlParams.get('url') ? decodeURIComponent(urlParams.get('url')!) : null;

if (isDetached) document.body.classList.add('detached');

/**
 * True on mobile browsers (Firefox for Android, etc.) that do not support
 * the browser.windows API.  On these platforms we skip all window-detach
 * logic to avoid silent failures.
 */
const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || typeof (browser as any).windows === 'undefined';

if (isMobile) {
    document.body.classList.add('mobile');
    // Hide the detach button on mobile — the feature is not available
    detachBtn?.style.setProperty('display', 'none');
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentTabId: number | null = null;
/** URL of the page currently being (or last) summarized — used as the session key */
let currentPageUrl: string | null = null;
let isSummarizing = false;
let currentPort: browser.Runtime.Port | null = null;

/**
 * True while summarization is in progress (first message received, not yet done).
 * Controls whether closing the popup triggers auto-detach.
 */
let hasStartedContent = false;

/**
 * Set to true when the user explicitly clicks the Detach button so that the
 * 'pagehide' handler doesn't fire a duplicate OPEN_DETACHED.
 */
let isDetachingManually = false;

// ---------------------------------------------------------------------------
// Auto-detach: when the attached popup is dismissed mid-summary, open a
// detached window so the user can keep reading the progress.
// Not supported on mobile (Firefox for Android lacks the windows API).
// ---------------------------------------------------------------------------
window.addEventListener('pagehide', () => {
    if (!isMobile && !isDetached && !isDetachingManually && hasStartedContent && currentPageUrl) {
        // Fire-and-forget — page is unloading so we cannot await
        browser.runtime.sendMessage({ action: 'OPEN_DETACHED', url: currentPageUrl });
    }
});

// ---------------------------------------------------------------------------
// Settings button
// ---------------------------------------------------------------------------
openSettingsBtn.addEventListener('click', () => {
    browser.runtime.openOptionsPage();
});

// ---------------------------------------------------------------------------
// Detach button (manual)
// ---------------------------------------------------------------------------
detachBtn.addEventListener('click', async () => {
    if (isMobile) return; // windows API not available on mobile

    isDetachingManually = true; // prevent pagehide from firing a duplicate

    const pageUrl = currentPageUrl ?? detachedPageUrl;
    if (!pageUrl) return;

    // Delegate to background so it can track the new window
    await browser.runtime.sendMessage({ action: 'OPEN_DETACHED', url: pageUrl });
    window.close();
});

// ---------------------------------------------------------------------------
// Retry button
// ---------------------------------------------------------------------------
retryBtn.addEventListener('click', () => {
    if (isSummarizing) return;
    currentPort?.disconnect();
    currentPort = null;
    startSummary(/* forceNew */ true);
});

// ---------------------------------------------------------------------------
// Core: resolve the target tab/URL, then stream the summary via background
// ---------------------------------------------------------------------------
async function startSummary(forceNew = false) {
    if (isSummarizing) return;
    isSummarizing = true;
    hasStartedContent = false;

    summaryEl.textContent = '';
    summaryEl.style.whiteSpace = '';
    statusEl.textContent = '';
    modelBadgeEl.textContent = '';

    // ---------------------------------------------------------------------------
    // Resolve tab and page URL
    // ---------------------------------------------------------------------------
    if (detachedPageUrl) {
        // Detached mode: find an open tab with the target URL
        currentPageUrl = detachedPageUrl;
        const tabs = await browser.tabs.query({ url: detachedPageUrl });
        currentTabId = tabs[0]?.id ?? null;
    } else {
        // Attached popup: use the active tab
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        currentTabId = activeTab?.id ?? null;
        currentPageUrl = activeTab?.url ?? null;
    }

    if (!currentPageUrl) {
        showError('Could not identify the target page.');
        return;
    }

    // ---------------------------------------------------------------------------
    // Session reuse path:
    // Send '__REUSE__' with the page URL — background replays the buffer and
    // subscribes us to future chunks. Falls back to full extraction if no session.
    // ---------------------------------------------------------------------------
    if (!forceNew) {
        try {
            showSkeleton();
            hasStartedContent = true;
            const port = browser.runtime.connect();
            currentPort = port;
            port.postMessage({
                action: 'START_SUMMARY',
                url: currentPageUrl,
                language: navigator.language,
                text: '__REUSE__',
            });

            const reused = await waitForFirstMessage(port);
            if (reused) return; // background had a session, we're done

            // No session in background — fall through to full extraction
            port.disconnect();
            currentPort = null;
        } catch {
            // fall through
        }
    }

    // ---------------------------------------------------------------------------
    // Full extraction path: pull text from the content script
    // ---------------------------------------------------------------------------
    if (!currentTabId) {
        showError('Could not find an open tab for this page.');
        return;
    }

    let extracted: any;
    try {
        extracted = await browser.tabs.sendMessage(currentTabId, { action: 'EXTRACT_TEXT' });
    } catch (e: any) {
        showError(`Could not reach page script: ${e.message}`);
        return;
    }

    if (!extracted || (Array.isArray(extracted) && extracted.length === 0)) {
        showError('No text found to summarize.');
        return;
    }

    const textContent = Array.isArray(extracted)
        ? extracted.join('\n\n')
        : (typeof extracted === 'string' ? extracted : JSON.stringify(extracted));

    showSkeleton();
    hasStartedContent = true;

    try {
        const port = browser.runtime.connect();
        currentPort = port;
        port.postMessage({
            action: 'START_SUMMARY',
            text: textContent,
            language: navigator.language,
            url: currentPageUrl,
        });
        attachPortListeners(port);
    } catch (err: any) {
        showError(err.message);
    }
}

// ---------------------------------------------------------------------------
// Wait for the very first message on a port.
// Returns true  → real session message (session was reused)
// Returns false → NO_SESSION sentinel (need full extraction)
// ---------------------------------------------------------------------------
function waitForFirstMessage(port: browser.Runtime.Port): Promise<boolean> {
    return new Promise(resolve => {
        const cleanup = () => {
            port.onMessage.removeListener(onMsg);
            port.onDisconnect.removeListener(onDisc);
        };

        const onMsg = (msg: any) => {
            if (msg.__sentinel === 'NO_SESSION') {
                cleanup();
                resolve(false);
                return;
            }
            // Real session message — attach full listeners and process this message too
            cleanup();
            const state = { hasFirstChunk: false, textBuffer: '', renderedLineCount: 0, currentUl: null as HTMLUListElement | null };
            port.onMessage.addListener((m: any) => handleMessage(m, port, state));
            port.onDisconnect.addListener(() => {
                isSummarizing = false;
                currentPort = null;
                if (!state.hasFirstChunk) showError('Connection lost.');
            });
            handleMessage(msg, port, state);
            resolve(true);
        };

        const onDisc = () => { cleanup(); resolve(false); };

        port.onMessage.addListener(onMsg);
        port.onDisconnect.addListener(onDisc);
    });
}

// ---------------------------------------------------------------------------
// Attach the standard streaming listeners to a port
// ---------------------------------------------------------------------------
function attachPortListeners(port: browser.Runtime.Port) {
    const state = { hasFirstChunk: false, textBuffer: '', renderedLineCount: 0, currentUl: null as HTMLUListElement | null };
    port.onMessage.addListener((msg: any) => handleMessage(msg, port, state));
    port.onDisconnect.addListener(() => {
        isSummarizing = false;
        currentPort = null;
        if (!state.hasFirstChunk) showError('Connection lost.');
    });
}

// ---------------------------------------------------------------------------
// Handle a single streaming message — shared between session replay & live stream
// ---------------------------------------------------------------------------
function handleMessage(
    msg: any,
    port: browser.Runtime.Port,
    state: { hasFirstChunk: boolean; textBuffer: string; renderedLineCount: number; currentUl: HTMLUListElement | null },
) {
    if (msg.__sentinel) return; // ignore internal sentinels

    hasStartedContent = true; // real content arrived

    if (msg.model_instance_id) {
        const parts = (msg.model_instance_id as string).split('/');
        modelBadgeEl.textContent = parts[parts.length - 1];
    }

    if (msg.type === 'model_load.start' || msg.type === 'model_load.progress') {
        const model = modelBadgeEl.textContent || '';
        statusEl.textContent = model ? `Loading ${model}…` : 'Loading model…';
        showSkeleton();

    } else if (msg.type === 'chat.start' || msg.type === 'prompt_processing.progress') {
        statusEl.textContent = 'Summarizing…';
        showSkeleton();

    } else if (msg.type === 'message.delta') {
        statusEl.textContent = '';
        if (!state.hasFirstChunk) {
            state.hasFirstChunk = true;
            summaryEl.textContent = '';
            summaryEl.style.whiteSpace = '';
            document.getElementById('skeleton-container')?.remove();
        }
        // Accumulate text for final bullet rendering
        state.textBuffer += msg.content;
        
        const lines = state.textBuffer.split('\n');
        // Render completed lines incrementally
        while (state.renderedLineCount < lines.length - 1) {
            appendDecodedLine(lines[state.renderedLineCount], summaryEl, state);
            state.renderedLineCount++;
        }

    } else if (msg.type === 'chat.end') {
        statusEl.textContent = '';
        if (state.textBuffer) {
            // Render the last remaining line
            const lines = state.textBuffer.split('\n');
            if (state.renderedLineCount < lines.length) {
                appendDecodedLine(lines[state.renderedLineCount], summaryEl, state);
                state.renderedLineCount++;
            }
        } else if (!state.hasFirstChunk && msg.result?.output) {
            state.hasFirstChunk = true;
            document.getElementById('skeleton-container')?.remove();
            const messageObj = msg.result.output.find((o: any) => o.type === 'message');
            if (messageObj) {
                const lines = (messageObj.content as string).split('\n');
                for (const line of lines) {
                    appendDecodedLine(line, summaryEl, state);
                }
            }
        }
        isSummarizing = false;
        currentPort = null;
        hasStartedContent = false; // summary complete — disable auto-detach
        port.disconnect();

    } else if (msg.type === 'error') {
        showError(msg.error?.message || 'Unknown error');
        port.disconnect();
    }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function appendDecodedLine(line: string, container: HTMLElement, state: { currentUl: HTMLUListElement | null }) {
    const trimmed = line.trim();
    if (!trimmed) return;

    const bulletMatch = line.match(/^\s*[-•*]\s+(.+)$/);
    let el: HTMLElement;

    if (bulletMatch) {
        if (!state.currentUl) {
            state.currentUl = document.createElement('ul');
            container.appendChild(state.currentUl);
        }
        el = document.createElement('li');
        el.textContent = bulletMatch[1].trim();
        state.currentUl.appendChild(el);
    } else {
        state.currentUl = null;
        el = document.createElement('p');
        el.textContent = trimmed;
        container.appendChild(el);
    }

    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s ease-in';
    void el.offsetWidth; // trigger reflow
    el.style.opacity = '1';
}

function showSkeleton() {
    if (document.getElementById('skeleton-container')) return;
    const skeleton = document.createElement('div');
    skeleton.id = 'skeleton-container';
    skeleton.className = 'skeleton-wrap';
    for (let i = 0; i < 4; i++) {
        const line = document.createElement('div');
        line.className = 'skeleton-line';
        skeleton.appendChild(line);
    }
    summaryEl.textContent = '';
    summaryEl.appendChild(skeleton);
}

function showError(msg: string) {
    isSummarizing = false;
    currentPort = null;
    document.getElementById('skeleton-container')?.remove();
    statusEl.textContent = '';
    summaryEl.innerHTML = `<span class="error-msg">⚠️ ${msg}</span>`;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
startSummary();
