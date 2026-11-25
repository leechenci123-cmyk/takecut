// Theme and language toggles shared by the top bars.

import { h, button } from "./dom.js";
import { t, getLang, setLang } from "../i18n.js";

const THEME_KEY = "takecut.theme";

function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* storage blocked */ }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

document.documentElement.dataset.theme = initialTheme();
const themeListeners = new Set();

export const getTheme = () => document.documentElement.dataset.theme;

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked */ }
  for (const fn of themeListeners) fn(theme);
}

export function onTheme(fn) {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

/** Language and theme buttons, plus an optional help button. */
export function prefButtons({ onHelp } = {}) {
  const themeBtn = button(null, {
    icon: getTheme() === "dark" ? "sun" : "moon", class: "ghost icon-only", title: t("pref.theme"),
    onclick: () => setTheme(getTheme() === "dark" ? "light" : "dark"),
  });
  return [
    button(t("pref.lang"), { icon: "language", class: "ghost collapse-label", title: t("pref.langTitle"), onclick: () => setLang(getLang() === "zh" ? "en" : "zh") }),
    themeBtn,
    onHelp && button(null, { icon: "keyboard", class: "ghost icon-only hide-narrow", title: t("pref.help"), onclick: onHelp }),
  ];
}

export function logo() {
  const mark = h("span", { class: "logo-mark" });
  mark.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><g fill="#c7f67a"><rect x="5" y="13" width="2.6" height="6" rx="1.3"/><rect x="9.8" y="9" width="2.6" height="14" rx="1.3"/><rect x="14.7" y="5.5" width="2.6" height="21" rx="1.3"/><rect x="19.6" y="10" width="2.6" height="12" rx="1.3"/><rect x="24.4" y="13.5" width="2.6" height="5" rx="1.3"/></g></svg>';
  return h("a", { class: "logo", href: "#/" }, mark, h("span", null, t("app.name")), h("small", null, "TAKECUT"));
}
