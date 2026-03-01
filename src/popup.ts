import browser from "webextension-polyfill";

document.addEventListener("DOMContentLoaded", async () => {
    const container = document.getElementById('summary-container');

    if (!container) return;

    try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const activeTab = tabs[0];
        if (!activeTab || !activeTab.id) {
            container.innerText = "활성화된 탭을 찾을 수 없습니다.";
            return;
        }

        const response = await browser.tabs.sendMessage(activeTab.id, { action: 'EXTRACT_TEXT' });

        if (!response || (Array.isArray(response) && response.length === 0)) {
            container.innerText = "페이지에서 요약할 텍스트를 찾을 수 없습니다.";
            return;
        }

        container.innerHTML = "<em>연결 중...</em>";

        const settings = await browser.storage.local.get(["lmstudioHost", "lmstudioModel"]);
        let host = (settings.lmstudioHost as string) || "http://127.0.0.1:1234";
        if (host.startsWith('ws://')) host = host.replace('ws://', 'http://');
        else if (host.startsWith('wss://')) host = host.replace('wss://', 'https://');
        if (host.endsWith('/')) {
            host = host.slice(0, -1);
        }

        const modelName = (settings.lmstudioModel as string) || "llama-3.2-1b-instruct";

        const textContent = Array.isArray(response) ? response.join('\n\n') : (typeof response === 'string' ? response : JSON.stringify(response));
        const promptContext = `Create a concise, under 750 characters summary of the following text in Korean. Only answer the summary. Do not include any other text. Do not include any reference tags.

Text:
${textContent}`;
        container.innerHTML = "<em>요약 중...</em>";

        const res = await fetch(`${host}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: modelName,
                messages: [{ role: "user", content: promptContext }],
                temperature: 0.7
            })
        });

        if (!res.ok) {
            throw new Error(`LM Studio API Error: ${res.statusText}`);
        }

        const prediction = await res.json();
        const summary = prediction.choices[0].message.content;

        container.style.opacity = '0';
        container.style.transform = 'translateY(10px)';

        // Wait for the fade-out to complete
        await new Promise(resolve => setTimeout(resolve, 300));

        renderText(summary, container, activeTab.id);

        // Force browser to recalculate layout so the fade-in will trigger from the 0/10px state
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                container.style.opacity = '1';
                container.style.transform = 'translateY(0)';
            });
        });

    } catch (error: any) {
        container.style.opacity = '1';
        container.style.transform = 'translateY(0)';
        container.innerHTML = `<strong>네트워크 오류 또는 LM Studio 연결 실패:</strong><br>${error.message}<br><br><small>확장 프로그램 설정에서 호스트가 올바른지 확인해주세요. 로컬 LM Studio 서버가 실행 중인지 확인하세요.</small>`;
        console.error(error)
    }
});

function renderText(markdown: string, container: HTMLElement, tabId: number) {
    let html = markdown
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") // basic sanitize to prevent XSS from LLM
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.*?)__/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/_(.*?)_/g, '<em>$1</em>')
        .replace(/\n\n/g, '<br><br>')
        .replace(/\n/g, '<br>');

    // The sanitization broke the brackets if any, but since we know [os-ref-] format, we can just replace:
    html = html.replace(/\[(os-ref-\d+)\]/g, '<a href="#" class="ref-link" data-ref="$1">[$1]</a>');

    container.innerHTML = `<div>${html}</div>`;

    container.querySelectorAll('.ref-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const ref = (e.target as HTMLElement).getAttribute('data-ref');
            if (ref) {
                browser.tabs.sendMessage(tabId, { action: 'SCROLL_TO_REF', id: ref }).catch(console.error);
            }
        });
    });
}
