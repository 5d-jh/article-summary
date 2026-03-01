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

browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg.action === 'FETCH_SUMMARY') {
        return handleFetchSummary(msg.text);
    }
});

async function handleFetchSummary(textContent: string) {
    try {
        const settings = await browser.storage.local.get(["lmstudioHost", "lmstudioModel"]);
        let host = (settings.lmstudioHost as string) || "http://127.0.0.1:1234";
        if (host.startsWith('ws://')) host = host.replace('ws://', 'http://');
        else if (host.startsWith('wss://')) host = host.replace('wss://', 'https://');
        if (host.endsWith('/')) {
            host = host.slice(0, -1);
        }

        const res = await fetch(new URL('/api/v1/chat', host), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'google/gemma-3-4b',
                system_prompt: 'Create a concise summary of the user\'s text in Korean. Do not exceed 4 sentences. Only answer the summary. Do not include any other text.',
                input: textContent,
                temperature: 0.7
            })
        });

        if (!res.ok) {
            throw new Error(`LM Studio API Error: ${res.statusText}`);
        }

        let prediction = await res.json();
        prediction = (prediction.output as any[]).find(it => (it as any).type === 'message')?.content

        return { success: true, summary: prediction };
    } catch (error: any) {
        console.error("Error in background doing summary fetch:", error);
        return { success: false, error: error.message };
    }
}
