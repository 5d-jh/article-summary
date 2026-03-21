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
        let target: Element | null = null;
        if (window.location.hostname.includes('gall.dcinside.com')) {
            target = document.querySelector('.gallview_contents');
        }

        if (!target) {
            target = document.querySelector('article') || document.querySelector('.article') || document.querySelector('main') || document.querySelector('body');
        }

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
