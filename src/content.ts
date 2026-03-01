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
            toggleFloatingSummaryWindow();
            return Promise.resolve({ success: true });
        }
    });

    let inlineSummaryContainer: HTMLElement | null = null;
    let isSummarizing = false;

    const header = document.createElement('div');

    function toggleFloatingSummaryWindow() {
        const target = document.querySelector('article') || document.querySelector('.article');
        if (!target) return;

        if (inlineSummaryContainer) {
            inlineSummaryContainer.remove();
            inlineSummaryContainer = null;
            return;
        }

        inlineSummaryContainer = document.createElement('div');
        inlineSummaryContainer.style.marginBottom = '2em';
        inlineSummaryContainer.style.padding = '1em';


        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.fontWeight = 'bold';
        header.style.marginBottom = '0.5em';
        header.style.opacity = '0.7';

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.style.background = 'none';
        closeBtn.style.border = 'none';
        closeBtn.style.fontSize = 'inherit';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.color = 'inherit';
        closeBtn.style.padding = '0';
        closeBtn.style.lineHeight = '1';
        closeBtn.onclick = () => {
            if (inlineSummaryContainer) {
                inlineSummaryContainer.remove();
                inlineSummaryContainer = null;
            }
        };

        header.appendChild(closeBtn);
        inlineSummaryContainer.appendChild(header);

        const contentBox = document.createElement('div');
        inlineSummaryContainer.appendChild(contentBox);
        contentBox.style.fontStyle = 'italic';

        // Insert before the first child of the target, or directly into parent if target is strictly formatted
        if (target.firstChild) {
            target.insertBefore(inlineSummaryContainer, target.firstChild);
        } else {
            target.appendChild(inlineSummaryContainer);
        }

        startSummarization(contentBox);
    }

    async function startSummarization(contentBox: HTMLElement) {
        if (isSummarizing) return;
        isSummarizing = true;

        header.innerText = '요약 중...';
        contentBox.innerHTML = `
            <div style="height: 1em; background: currentColor; opacity: 0.15; border-radius: 4px; margin-bottom: 0.6em; width: 100%;"></div>
            <div style="height: 1em; background: currentColor; opacity: 0.15; border-radius: 4px; margin-bottom: 0.6em; width: 85%;"></div>
            <div style="height: 1em; background: currentColor; opacity: 0.15; border-radius: 4px; width: 92%;"></div>
        `;

        const container = contentBox.parentElement!;
        const pulseAnimation = container.animate([
            { opacity: 0.5 },
            { opacity: 1 },
            { opacity: 0.5 }
        ], {
            duration: 1500,
            iterations: Infinity,
            easing: 'ease-in-out'
        });

        const extracted = extractText();
        if (!extracted || (Array.isArray(extracted) && extracted.length === 0)) {
            pulseAnimation.cancel();
            contentBox.innerText = "요약할 텍스트를 찾을 수 없습니다.";
            isSummarizing = false;
            return;
        }

        const textContent = Array.isArray(extracted) ? extracted.join('\n\n') : (typeof extracted === 'string' ? extracted : JSON.stringify(extracted));

        try {
            const response = await browser.runtime.sendMessage({ action: 'FETCH_SUMMARY', text: textContent });
            pulseAnimation.cancel();
            if (response && response.success) {
                header.innerText = '요약';
                contentBox.innerText = response.summary;
                inlineSummaryContainer?.scrollIntoView({ behavior: 'smooth' });
            } else {
                contentBox.innerHTML = `<strong>오류 발생:</strong><br>${response?.error || '알 수 없는 오류'}`;
            }
        } catch (err: any) {
            pulseAnimation.cancel();
            contentBox.innerHTML = `<strong>네트워크 오류:</strong><br>${err.message}`;
        }

        isSummarizing = false;
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
        const target = document.querySelector('article') || document.querySelector('.article');
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
