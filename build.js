const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const outDirChrome = path.join(__dirname, 'dist', 'chrome');
const outDirFirefox = path.join(__dirname, 'dist', 'firefox');

// Ensure directories exist
[outDirChrome, outDirFirefox].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Build typescript files
const tsFiles = ['src/options.ts', 'src/content.ts', 'src/background.ts', 'src/popup.ts'];
esbuild.buildSync({
    entryPoints: tsFiles,
    outdir: 'dist/temp',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
});

// Generate icons from SVG using macs native sips tool
const iconSizes = [16, 32, 48, 128];
iconSizes.forEach(size => {
    console.log(`Generating ${size}x${size} icon...`);
    execSync(`sips -s format png -z ${size} ${size} icon.svg --out icon${size}.png`);
});

// Generate dark-mode icons (bright version for dark backgrounds)
iconSizes.forEach(size => {
    console.log(`Generating ${size}x${size} dark-mode icon...`);
    execSync(`sips -s format png -z ${size} ${size} icon-dark.svg --out icon${size}-dark.png`);
});

// Copy assets and dist/temp to both browsers
const assets = ['src/options.html', 'src/popup.html', 'src/styles.css', 'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png', 'icon16-dark.png', 'icon32-dark.png', 'icon48-dark.png', 'icon128-dark.png'];

const manifestBase = {
    name: "MyGist",
    version: "1.3.1",
    description: "Summarize webpages privately using your own local LLMs.",
    permissions: ["storage", "activeTab"],
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
    ],
    icons: {
        "16": "icon16.png",
        "32": "icon32.png",
        "48": "icon48.png",
        "128": "icon128.png"
    }
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
        default_popup: "popup.html",
        theme_icons: iconSizes.map(size => ({
            light: `icon${size}-dark.png`,
            dark: `icon${size}.png`,
            size: size
        })),
        default_icon: 'icon48.png'
    },
    background: {
        scripts: ["background.js"]
    },
    browser_specific_settings: {
        gecko: {
            id: "mygist@5d-jh.dev",
            strict_min_version: "109.0",
            data_collection_permissions: {
                required: ["none"]
            }
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
    ['options.js', 'content.js', 'background.js', 'popup.js'].forEach(f => {
        fs.copyFileSync(path.join(__dirname, 'dist', 'temp', f), path.join(destDir, f));
    });
    // ['options.js.map', 'content.js.map', 'background.js.map'].forEach(f => {
    //     fs.copyFileSync(path.join(__dirname, 'dist', 'temp', f), path.join(destDir, f));
    // });
    assets.forEach(f => {
        fs.copyFileSync(path.join(__dirname, f), path.join(destDir, path.basename(f)));
    });
};

copyFiles('dist/temp', outDirChrome);
copyFiles('dist/temp', outDirFirefox);

console.log("Build complete! Extensions are in dist/chrome and dist/firefox.");
