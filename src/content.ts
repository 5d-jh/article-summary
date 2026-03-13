import browser from "webextension-polyfill";


(() => {
    if ((window as any).__os_injected) return;
    (window as any).__os_injected = true;

    browser.runtime.onMessage.addListener((msg, _) => {
        if (msg.action === 'EXTRACT_TEXT') {
            const result = extractText();
            return Promise.resolve(result);
        } else if (msg.action === 'SCROLL_TO_REF') {
            scrollToRef(msg.id);
            return Promise.resolve({ success: true });
        } else if (msg.action === 'TOGGLE_SUMMARY_WINDOW') {
            toggleSummaryPanel();
            return Promise.resolve({ success: true });
        }
    });

    let inlineSummaryContainer: HTMLElement | null = null;
    let isSummarizing = false;

    function toggleSummaryPanel() {
        // If already in the DOM, just toggle visibility
        if (inlineSummaryContainer) {
            inlineSummaryContainer.remove();
            inlineSummaryContainer = null;
            return;
        }

        inlineSummaryContainer = document.createElement('div');

        if (!document.getElementById('ollama-summary-style')) {
            const style = document.createElement('style');
            style.id = 'ollama-summary-style';
            style.textContent = `
                #ollama-summary-popup {
                    position: fixed;
                    z-index: 2147483647;
                    background: #ffffff;
                    color: #333333;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                    border-radius: 8px;
                    padding: 16px;
                    box-sizing: border-box;
                    display: flex;
                    flex-direction: column;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
                    font-size: 14px;
                    line-height: 1.5;
                }
                #ollama-summary-popup * {
                    box-sizing: border-box;
                }

                #ollama-summary-popup-close {
                    background: transparent;
                    border: none;
                    cursor: pointer;
                    color: #999;
                    line-height: 1; 
                    padding-top: 0.3em;
                    font-size: 1.2em;
                }
                #ollama-summary-popup-close:hover {
                    color: #333;
                }
                #ollama-summary-popup-content {
                    overflow-y: auto;
                    flex-grow: 1;
                }
                #ollama-summary-popup-content::-webkit-scrollbar {
                    width: 6px;
                }
                #ollama-summary-popup-content::-webkit-scrollbar-thumb {
                    background: #cccccc;
                    border-radius: 3px;
                }
                
                @media (min-width: 768px) {
                    #ollama-summary-popup {
                        top: 20px;
                        right: 20px;
                        width: 400px;
                        max-height: calc(100vh - 40px);
                    }
                }
                @media (max-width: 767px) {
                    #ollama-summary-popup {
                        bottom: 0px;
                        left: 0px;
                        right: 0px;
                        width: 100%;
                        max-height: 50vh;
                        border-bottom-left-radius: 0;
                        border-bottom-right-radius: 0;
                        box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.1);
                    }
                }
                @media (prefers-color-scheme: dark) {
                    #ollama-summary-popup {
                        background: #1e1e1e;
                        color: #e0e0e0;
                        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
                    }
                    @media (max-width: 767px) {
                        #ollama-summary-popup {
                            box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.5);
                        }
                    }

                    #ollama-summary-popup-close {
                        color: #888;
                    }
                    #ollama-summary-popup-close:hover {
                        color: #ccc;
                    }
                    #ollama-summary-popup-content::-webkit-scrollbar-thumb {
                        background: #555555;
                    }
                    .ollama-skeleton-line {
                        background-image: linear-gradient(90deg, #2a2a2a 25%, #3a3a3a 50%, #2a2a2a 75%);
                    }
                }

                .ollama-skeleton-line {
                    height: 14px;
                    border-radius: 4px;
                    background: linear-gradient(90deg, #e0e0e0 25%, #f0f0f0 50%, #e0e0e0 75%);
                    background-size: 200% 100%;
                    animation: ollama-skeleton-pulse 1.5s ease-in-out infinite;
                    margin-bottom: 10px;
                    opacity: 0.6;
                }
                .ollama-skeleton-line:nth-child(1) { width: 95%; }
                .ollama-skeleton-line:nth-child(2) { width: 80%; }
                .ollama-skeleton-line:nth-child(3) { width: 60%; }

                @keyframes ollama-skeleton-pulse {
                    0% { background-position: 200% 0; }
                    100% { background-position: -200% 0; }
                }
            `;
            document.head.appendChild(style);
        }


        inlineSummaryContainer.id = 'ollama-summary-popup';

        const contentBox = document.createElement('div');
        contentBox.id = 'ollama-summary-popup-content';
        inlineSummaryContainer.appendChild(contentBox);

        inlineSummaryContainer.hidden = false;
        document.body.appendChild(inlineSummaryContainer);

        const closeBtn = document.createElement('button');
        closeBtn.id = 'ollama-summary-popup-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = () => {
            inlineSummaryContainer?.remove();
            inlineSummaryContainer = null;
        };
        inlineSummaryContainer.appendChild(closeBtn);

        startSummarization(contentBox);
    }

    async function startSummarization(contentBox: HTMLElement) {
        if (isSummarizing) return;
        isSummarizing = true;

        const extracted = extractText();
        if (!extracted || (Array.isArray(extracted) && extracted.length === 0)) {
            contentBox.innerText = "요약할 텍스트를 찾을 수 없습니다.";
            isSummarizing = false;
            return;
        }

        const textContent = Array.isArray(extracted) ? extracted.join('\n\n') : (typeof extracted === 'string' ? extracted : JSON.stringify(extracted));

        try {
            const port = browser.runtime.connect({ name: 'summary' });
            port.postMessage({ action: 'START_SUMMARY', text: textContent, language: navigator.language });

            let hasReceivedMessage = false;
            let currentModel = '';

            port.onMessage.addListener((msg: any) => {
                if (msg.model_instance_id) {
                    const parts = msg.model_instance_id.split('/');
                    currentModel = parts[parts.length - 1]; // simplify model name
                }

                if (msg.type === 'model_load.start' || msg.type === 'model_load.progress') {
                    contentBox.innerText = `${currentModel}...`;
                }

                if (msg.type === 'chat.start' || msg.type === 'prompt_processing.progress') {
                    if (!hasReceivedMessage) {
                        contentBox.innerHTML = `
                            <div class="ollama-skeleton-line"></div>
                            <div class="ollama-skeleton-line"></div>
                            <div class="ollama-skeleton-line"></div>
                        `;
                    }
                } else if (msg.type === 'message.delta') {
                    if (!hasReceivedMessage) {
                        hasReceivedMessage = true;
                        contentBox.innerText = '';
                        contentBox.style.whiteSpace = 'pre-wrap';
                    }
                    const span = document.createElement('span');
                    span.textContent = msg.content;
                    span.style.opacity = '0';
                    span.style.transition = 'opacity 0.2s ease-in';
                    contentBox.appendChild(span);

                    // Trigger reflow to apply transition
                    void span.offsetWidth;
                    span.style.opacity = '1';
                } else if (msg.type === 'chat.end') {
                    if (!hasReceivedMessage) {
                        hasReceivedMessage = true;
                        if (msg.result?.output) {
                            const messageObj = msg.result.output.find((o: any) => o.type === 'message');
                            if (messageObj) {
                                contentBox.innerText = messageObj.content;
                            }
                        }
                    }
                    isSummarizing = false;
                    port.disconnect();
                } else if (msg.type === 'error') {
                    contentBox.innerHTML = `<strong>Error:</strong><br> ${msg.error?.message || 'Unknown Error'}`;
                    port.disconnect();
                }
            });

            port.onDisconnect.addListener(() => {
                if (!hasReceivedMessage) {
                    contentBox.innerHTML += `<strong>Error:</strong><br> disconnected`;
                }
            });

        } catch (err: any) {
            contentBox.innerHTML = `<strong>Error:</strong><br> ${err.message}`;
        }
    }

    function scrollToRef(id: string) {
        const el = document.getElementById(id);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });

            const originalBg = el.style.backgroundColor;
            const originalTransition = el.style.transition;

            el.style.transition = 'background-color 0.5s ease';
            el.style.backgroundColor = 'rgba(255, 255, 0, 0.4)'; // subtle highlight

            setTimeout(() => {
                el.style.backgroundColor = originalBg;
                setTimeout(() => {
                    el.style.transition = originalTransition;
                }, 500);
            }, 2000);
        }
    }

    function extractText() {
        const target = document.querySelector('article') || document.querySelector('.article') || document.querySelector('main') || document.querySelector('body');
        if (!target) return [];

        let counter = 0;
        const items: string[] = [];

        let blocks: Element[] = Array.from(target.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote'));
        if (blocks.length === 0) {
            blocks = [target];
        }

        for (const el of blocks) {
            if (el.closest('script, style, nav, footer, header, aside')) continue;

            const text = el.textContent?.trim() || "";
            if (text.length < 20) continue;

            let id = el.id || el.getAttribute('data-os-id');
            if (!id || id.startsWith('os-ref-')) {
                id = `os-ref-${++counter}`;
                el.id = id;
                el.setAttribute('data-os-id', id);
            }

            items.push(`[${id}] ${text}`);
        }

        if (items.length === 0) {
            const bodyText = document.body.innerText || target.textContent || "";
            return `{ "id": "os-ref-body", "text": ${JSON.stringify(bodyText.substring(0, 10000))} }`;
        }

        return items;
    }
})();
