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
        }
    });

    function initPopup() {
        const article = document.querySelector('article');
        if (!article) return;

        let isSummarizing = false;

        function createSummarizeSection() {
            const wrapper = document.createElement('div');
            wrapper.style.margin = '24px 0';
            wrapper.style.width = '100%';
            wrapper.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

            const btn = document.createElement('button');
            btn.innerText = '💡 현재 문서 요약하기';
            btn.style.display = 'block';
            btn.style.margin = '0 auto';
            btn.style.padding = '14px 24px';
            btn.style.borderRadius = '50px';
            btn.style.border = '1px solid #ddd';
            btn.style.backgroundColor = '#fff';
            btn.style.color = '#333';
            btn.style.fontSize = '16px';
            btn.style.fontWeight = 'bold';
            btn.style.cursor = 'pointer';
            btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
            btn.style.transition = 'all 0.2s ease';

            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                btn.style.backgroundColor = '#333';
                btn.style.color = '#eee';
                btn.style.borderColor = '#555';
            }

            btn.onmouseover = () => btn.style.transform = 'translateY(-2px)';
            btn.onmouseout = () => btn.style.transform = 'none';

            const summaryBox = document.createElement('div');
            summaryBox.style.display = 'none';
            summaryBox.style.backgroundColor = '#fff';
            summaryBox.style.border = '1px solid #ddd';
            summaryBox.style.borderRadius = '12px';
            summaryBox.style.padding = '20px';
            summaryBox.style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)';
            summaryBox.style.color = '#333';
            summaryBox.style.fontSize = '15px';
            summaryBox.style.lineHeight = '1.6';

            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                summaryBox.style.backgroundColor = '#2c2c2c';
                summaryBox.style.borderColor = '#444';
                summaryBox.style.color = '#eee';
            }

            wrapper.appendChild(btn);
            wrapper.appendChild(summaryBox);

            btn.addEventListener('click', async () => {
                if (isSummarizing) return;

                isSummarizing = true;
                btn.style.display = 'none';
                summaryBox.style.display = 'block';
                summaryBox.innerHTML = '<em>요약 중...</em>';

                const extracted = extractText();
                if (!extracted || (Array.isArray(extracted) && extracted.length === 0)) {
                    summaryBox.innerText = "요약할 텍스트를 찾을 수 없습니다.";
                    isSummarizing = false;
                    return;
                }

                const textContent = Array.isArray(extracted) ? extracted.join('\n\n') : (typeof extracted === 'string' ? extracted : JSON.stringify(extracted));

                try {
                    const response = await browser.runtime.sendMessage({ action: 'FETCH_SUMMARY', text: textContent });
                    if (response && response.success) {
                        summaryBox.innerHTML = '';
                        renderTextToBox(response.summary, summaryBox);
                    } else {
                        summaryBox.innerHTML = `<strong>오류 발생:</strong><br>${response?.error || '알 수 없는 오류'}`;
                    }
                } catch (err: any) {
                    summaryBox.innerHTML = `<strong>네트워크 오류:</strong><br>${err.message}`;
                }

                isSummarizing = false;
            });

            return wrapper;
        }

        const topSection = createSummarizeSection();
        const bottomSection = createSummarizeSection();

        article.parentNode?.insertBefore(topSection, article);
        article.parentNode?.insertBefore(bottomSection, article.nextSibling);

        function renderTextToBox(markdown: string, box: HTMLElement) {
            let html = markdown
                .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/__(.*?)__/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                .replace(/_(.*?)_/g, '<em>$1</em>')
                .replace(/\n\n/g, '<br><br>')
                .replace(/\n/g, '<br>');

            html = html.replace(/\[(os-ref-\d+)\]/g, '<a href="#" class="os-ref-link" data-ref="$1" style="color:#0066cc;text-decoration:none;font-size:0.9em;font-weight:bold;margin:0 2px;">[$1]</a>');

            box.innerHTML = `<div>${html}</div>`;

            box.querySelectorAll('.os-ref-link').forEach((link) => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const ref = (e.target as HTMLElement).getAttribute('data-ref');
                    if (ref) {
                        scrollToRef(ref);
                    }
                });
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPopup);
    } else {
        initPopup();
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
        const target = document.querySelector('article');
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
