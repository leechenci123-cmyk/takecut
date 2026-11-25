// UI language (中文 / English). Strings live in locales/*.js; {name} placeholders are filled from vars.

import zh from "./locales/zh.js";
import en from "./locales/en.js";

const DICTS = { zh, en };
const KEY = "takecut.lang";
const listeners = new Set();

function initial() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved in DICTS) return saved;
  } catch { /* storage blocked */ }
  return (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
}

let lang = initial();
document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

export const getLang = () => lang;

export function setLang(next) {
  if (!(next in DICTS) || next === lang) return;
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked */ }
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const fn of listeners) fn(lang);
}

export function onLang(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key, vars) {
  let s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
  return s;
}

/** Translate an API error code, falling back to a generic message. */
export function errorText(err) {
  const code = err?.code ?? String(err);
  const key = "err." + code;
  return t(key) !== key ? t(key) : t("err.generic", { code });
}
