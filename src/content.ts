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
    let titleSpan: HTMLSpanElement | null = null;

    function toggleSummaryPanel() {
        if (inlineSummaryContainer) {
            inlineSummaryContainer.remove();
            inlineSummaryContainer = null;
            return;
        }

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
                #ollama-summary-popup-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    font-weight: bold;
                    margin-bottom: 12px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid #eeeeee;
                }
                #ollama-summary-popup-close {
                    background: transparent;
                    border: none;
                    font-size: 20px;
                    cursor: pointer;
                    color: #999;
                    padding: 0;
                    line-height: 1;
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
                    #ollama-summary-popup-header {
                        border-bottom-color: #333333;
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
                }
            `;
            document.head.appendChild(style);
        }

        inlineSummaryContainer = document.createElement('div');
        inlineSummaryContainer.id = 'ollama-summary-popup';

        const header = document.createElement('div');
        header.id = 'ollama-summary-popup-header';

        titleSpan = document.createElement('span');
        titleSpan.innerText = '요약 중...';

        const closeBtn = document.createElement('button');
        closeBtn.id = 'ollama-summary-popup-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = () => {
            if (inlineSummaryContainer) {
                inlineSummaryContainer.remove();
                inlineSummaryContainer = null;
            }
        };

        header.appendChild(titleSpan);
        header.appendChild(closeBtn);
        inlineSummaryContainer.appendChild(header);

        const contentBox = document.createElement('div');
        contentBox.id = 'ollama-summary-popup-content';
        inlineSummaryContainer.appendChild(contentBox);

        document.body.appendChild(inlineSummaryContainer);

        startSummarization(contentBox);
    }

    async function startSummarization(contentBox: HTMLElement) {
        if (isSummarizing) return;
        isSummarizing = true;

        if (titleSpan) titleSpan.innerText = '요약 중...';

        let pulseAnimation: Animation | null = null;
        if (titleSpan) {
            pulseAnimation = titleSpan.animate([
                { opacity: 0.5 },
                { opacity: 1 },
                { opacity: 0.5 }
            ], {
                duration: 1500,
                iterations: Infinity,
                easing: 'ease-in-out'
            });
        }

        const extracted = extractText();
        if (!extracted || (Array.isArray(extracted) && extracted.length === 0)) {
            if (pulseAnimation) pulseAnimation.cancel();
            contentBox.innerText = "요약할 텍스트를 찾을 수 없습니다.";
            isSummarizing = false;
            return;
        }

        const textContent = Array.isArray(extracted) ? extracted.join('\n\n') : (typeof extracted === 'string' ? extracted : JSON.stringify(extracted));

        try {
            contentBox.innerText = '준비 중...';
            const port = browser.runtime.connect({ name: 'summary' });
            port.postMessage({ action: 'START_SUMMARY', text: textContent });

            let hasReceivedMessage = false;
            let currentModel = '';

            port.onMessage.addListener((msg: any) => {
                if (msg.model_instance_id) {
                    const parts = msg.model_instance_id.split('/');
                    currentModel = parts[parts.length - 1]; // simplify model name
                }

                if (titleSpan) {
                    titleSpan.innerText = '요약 중...';
                }

                if (msg.type === 'model_load.start' || msg.type === 'model_load.progress') {
                    contentBox.innerText = '모델 로딩 중...'
                }

                if (msg.type === 'chat.start' || msg.type === 'prompt_processing.progress') {
                    if (!hasReceivedMessage) {
                        titleSpan!.innerText = '요약 중...';
                    }
                } else if (msg.type === 'reasoning.start' || msg.type === 'reasoning.delta') {
                    if (!hasReceivedMessage) {
                        contentBox.innerText = '생각 중...'
                    }
                } else if (msg.type === 'message.delta') {
                    if (!hasReceivedMessage) {
                        hasReceivedMessage = true;
                        contentBox.innerText = '';
                        contentBox.style.whiteSpace = 'pre-wrap';
                        if (pulseAnimation) pulseAnimation.cancel();
                        if (titleSpan) titleSpan.style.opacity = '1';
                        titleSpan!.innerText = '요약';
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
                        if (pulseAnimation) pulseAnimation.cancel();
                        if (titleSpan) titleSpan.style.opacity = '1';
                        titleSpan!.innerText = '요약';
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
                    if (pulseAnimation) pulseAnimation.cancel();
                    contentBox.innerHTML = `<strong>오류 발생:</strong><br>${msg.error?.message || '알 수 없는 오류'}`;
                    isSummarizing = false;
                    port.disconnect();
                }
            });

            port.onDisconnect.addListener(() => {
                if (isSummarizing) {
                    if (pulseAnimation) pulseAnimation.cancel();
                    if (titleSpan) titleSpan.style.opacity = '1';
                    if (!hasReceivedMessage) {
                        contentBox.innerHTML += `<br><strong>연결이 끊어졌습니다.</strong>`;
                    }
                    isSummarizing = false;
                }
            });

        } catch (err: any) {
            if (pulseAnimation) pulseAnimation.cancel();
            if (titleSpan) titleSpan.style.opacity = '1';
            contentBox.innerHTML = `<strong>네트워크 오류:</strong><br>${err.message}`;
            isSummarizing = false;
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
