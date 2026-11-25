// Dev helper (not needed to run Takecut): capture README screenshots with the installed Chrome
// over the DevTools protocol, waiting until each view has really finished loading.
//
//   node scripts/screenshots.mjs http://127.0.0.1:8772 docs "name|#/p/<id>|en|light|<js before capture>" ...
//
// Set CHROME to the browser executable if it isn't in the default Windows location.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const [base, outDir, ...shots] = process.argv.slice(2);
const port = 9333;
const profile = mkdtempSync(join(tmpdir(), "takecut-shot-"));
const browser = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page");
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket((await pageTarget()).webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let next = 0;
const waiting = new Map();
ws.addEventListener("message", e => {
  const msg = JSON.parse(e.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
});
const send = (method, params = {}) => new Promise(r => { const id = ++next; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });
try {
  for (const spec of shots) {
    const [name, hash, lang, theme, script] = spec.split("|");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await send("Page.navigate", { url: `${base}/` });
    await sleep(600);
    await evaluate(`localStorage.setItem("takecut.lang", ${JSON.stringify(lang)});
      localStorage.setItem("takecut.theme", ${JSON.stringify(theme)});
      localStorage.setItem("takecut.banner.dismissed", "1"); true`);
    await send("Page.navigate", { url: `${base}/${hash}` });
    await sleep(300);
    await send("Page.reload");
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      await sleep(250);
      ready = await evaluate(`!!(document.querySelector(".dock .play-btn") || document.querySelector(".home-main .project, .home-main .empty-projects"))`);
    }
    if (!ready) console.warn(`${name}: view did not finish loading`);
    if (script) await evaluate(`(async () => { ${script} })()`);
    await sleep(900);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot.result.data, "base64"));
    console.log(`wrote ${name}.png`);
  }
} finally {
  ws.close();
  browser.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
}
