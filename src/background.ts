import browser from "webextension-polyfill";

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

        const modelName = (settings.lmstudioModel as string) || "llama-3.2-1b-instruct";

        const promptContext = `Create a concise, under 750 characters summary of the following text in Korean. Only answer the summary. Do not include any other text. Do not include any reference tags.\n\nText:\n${textContent}`;

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

        return { success: true, summary };
    } catch (error: any) {
        console.error("Error in background doing summary fetch:", error);
        return { success: false, error: error.message };
    }
}
