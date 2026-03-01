async function main() {
    try {
        const response = await fetch("http://127.0.0.1:1234/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "llama-3.2-1b-instruct",
                messages: [{ role: "user", content: "hello?" }],
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.statusText}`);
        }

        const data = await response.json();
        console.log(data.choices[0].message.content);

    } catch (e) {
        console.error(e);
    }
}

main();
