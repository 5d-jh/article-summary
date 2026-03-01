const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const outDirChrome = path.join(__dirname, 'dist', 'chrome');
const outDirFirefox = path.join(__dirname, 'dist', 'firefox');

// Ensure directories exist
[outDirChrome, outDirFirefox].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Build typescript files
const tsFiles = ['src/popup.ts', 'src/options.ts', 'src/content.ts', 'src/background.ts'];
esbuild.buildSync({
    entryPoints: tsFiles,
    outdir: 'dist/temp',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    sourcemap: true
});

// Copy assets and dist/temp to both browsers
const assets = ['src/popup.html', 'src/options.html', 'src/styles.css'];

const manifestBase = {
    name: "Article Summary",
    version: "1.0",
    description: "Browser extension to summarize web content using your local LLMs.",
    permissions: ["storage", "activeTab", "scripting"],
    host_permissions: ["http://*/*", "https://*/*", "<all_urls>"],
    options_ui: {
        page: "options.html",
        open_in_tab: true
    },
    action: {
        default_popup: "popup.html"
    },
    content_scripts: [
        {
            matches: ["<all_urls>"],
            js: ["content.js"]
        }
    ]
};

// --- Chrome Manifest (V3) ---
const manifestChrome = {
    ...manifestBase,
    manifest_version: 3,
    background: {
        service_worker: "background.js",
        type: "module"
    }
};

// --- Firefox Manifest (V2 or V3) ---
// Note: Firefox Android works well with V2 for extensions, but V3 is supported from 109+. Let's use V3 with browser_specific_settings.
const manifestFirefox = {
    ...manifestBase,
    manifest_version: 2,
    browser_action: {
        default_popup: "popup.html"
    },
    background: {
        scripts: ["background.js"]
    },
    browser_specific_settings: {
        gecko: {
            id: "ollamasummary@example.com",
            strict_min_version: "109.0"
        }
    }
};
// In V2, host_permissions are inside permissions
manifestFirefox.permissions = [...manifestFirefox.permissions, "<all_urls>", "http://*/*", "https://*/*"];
delete manifestFirefox.host_permissions;
delete manifestFirefox.action;

// Write Manifests
fs.writeFileSync(path.join(outDirChrome, 'manifest.json'), JSON.stringify(manifestChrome, null, 2));
fs.writeFileSync(path.join(outDirFirefox, 'manifest.json'), JSON.stringify(manifestFirefox, null, 2));

// Copy files
const copyFiles = (srcDir, destDir) => {
    ['popup.js', 'options.js', 'content.js', 'background.js'].forEach(f => {
        fs.copyFileSync(path.join(__dirname, 'dist', 'temp', f), path.join(destDir, f));
    });
    ['popup.js.map', 'options.js.map', 'content.js.map', 'background.js.map'].forEach(f => {
        fs.copyFileSync(path.join(__dirname, 'dist', 'temp', f), path.join(destDir, f));
    });
    assets.forEach(f => {
        fs.copyFileSync(path.join(__dirname, f), path.join(destDir, path.basename(f)));
    });
};

copyFiles('dist/temp', outDirChrome);
copyFiles('dist/temp', outDirFirefox);

console.log("Build complete! Extensions are in dist/chrome and dist/firefox.");
