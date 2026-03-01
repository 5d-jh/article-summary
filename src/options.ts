import browser from "webextension-polyfill";

document.addEventListener("DOMContentLoaded", async () => {
    const hostInput = document.getElementById("host") as HTMLInputElement;
    const modelInput = document.getElementById("model") as HTMLSelectElement;
    const form = document.getElementById("options-form") as HTMLFormElement;
    const status = document.getElementById("status") as HTMLElement;

    const data = await browser.storage.local.get(["lmstudioHost", "lmstudioModel"]);
    if (data.lmstudioHost) hostInput.value = data.lmstudioHost as string;

    async function loadModels() {
        let host = hostInput.value.trim() || "http://127.0.0.1:1234";

        if (host.startsWith('ws://')) host = host.replace('ws://', 'http://');
        else if (host.startsWith('wss://')) host = host.replace('wss://', 'https://');

        if (host.endsWith('/')) {
            host = host.slice(0, -1);
        }

        try {
            const response = await fetch(`${host}/v1/models`);
            if (!response.ok) {
                throw new Error("Failed to fetch models: " + response.statusText);
            }
            const modelsData = await response.json();
            const models = modelsData.data;

            modelInput.innerHTML = ""; // clear default loading or old options

            if (models && models.length > 0) {
                models.forEach((m: any) => {
                    const opt = document.createElement("option");
                    const name = m.id;
                    opt.value = name;
                    opt.textContent = name;
                    modelInput.appendChild(opt);
                });
            } else {
                const opt = document.createElement("option");
                opt.value = "";
                opt.textContent = "다운로드된 모델이 없습니다.";
                opt.disabled = true;
                modelInput.appendChild(opt);
            }
        } catch (e) {
            console.error(e);
            modelInput.innerHTML = "";
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "LM Studio 연결 실패";
            opt.disabled = true;
            modelInput.appendChild(opt);
        }

        // Apply saved model if it exists in the options or fallback gracefully
        const savedModel = data.lmstudioModel as string | undefined;
        if (savedModel) {
            modelInput.value = savedModel;
            // if the saved model isn't in the list, add it
            if (modelInput.value !== savedModel) {
                const opt = document.createElement("option");
                opt.value = savedModel;
                opt.textContent = savedModel;
                modelInput.appendChild(opt);
                modelInput.value = savedModel;
            }
        }
    }

    await loadModels();

    hostInput.addEventListener("change", loadModels);

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const host = hostInput.value.trim() || "http://127.0.0.1:1234";
        const model = modelInput.value;
        await browser.storage.local.set({ lmstudioHost: host, lmstudioModel: model });

        status.textContent = "설정이 저장되었습니다.";
        setTimeout(() => { status.textContent = ""; }, 3000);
    });
});

