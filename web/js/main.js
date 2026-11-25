// Entry point: theme, router (#/ = projects, #/p/<id> = editor) and drag-and-drop import.

import { t, getLang, onLang } from "./i18n.js";
import { onTheme } from "./ui/prefs.js";
import { mountHome, importFile } from "./ui/home.js";
import { mountEditor } from "./ui/editor.js";
import { icon } from "./ui/icons.js";

const app = document.getElementById("app");
let view = null;

function route() {
  view?.destroy?.();
  app.replaceChildren();
  const match = /^#\/p\/([0-9a-f]{32})$/.exec(location.hash);
  document.title = getLang() === "zh" ? "复听 · Takecut" : "Takecut · 复听";
  view = match ? mountEditor(app, match[1]) : mountHome(app);
}

window.addEventListener("hashchange", route);
onLang(() => (view?.relocalize ? view.relocalize() : route()));
onTheme(() => view?.retheme?.());

// Drop a recording anywhere to import it.
const drop = document.getElementById("drop");
drop.querySelector("[data-icon]").replaceWith(icon("upload", "drop-icon"));
let depth = 0;
const hasFiles = e => Array.from(e.dataTransfer?.types ?? []).includes("Files");
window.addEventListener("dragenter", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth++;
  document.getElementById("dropText").textContent = t("home.drop");
  drop.hidden = false;
});
window.addEventListener("dragover", e => hasFiles(e) && e.preventDefault());
window.addEventListener("dragleave", e => {
  if (!hasFiles(e)) return;
  depth = Math.max(0, depth - 1);
  if (!depth) drop.hidden = true;
});
window.addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  drop.hidden = true;
  const file = e.dataTransfer.files[0];
  if (file) importFile(file);
});

route();
