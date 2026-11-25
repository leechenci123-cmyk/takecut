// Tiny DOM helpers: h() builds elements, plus number and time formatting.

import { icon } from "./icons.js";

const PROPS = new Set(["value", "checked", "disabled", "hidden", "selected", "indeterminate", "open"]);

/** h("button", {class: "btn", onclick}, icon("play"), "Play") */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (PROPS.has(key)) el[key] = value;
      else el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** A button with an optional leading icon. */
export function button(label, { icon: name, class: cls = "", title, onclick, disabled, pressed, kbd } = {}) {
  return h("button", {
    type: "button", class: `btn ${cls}`.trim(), title: title ?? (label ? null : undefined), "aria-label": label ? null : title,
    onclick, disabled, "aria-pressed": pressed == null ? null : String(pressed),
  }, name && icon(name), label, kbd && h("kbd", null, kbd));
}

export const iconButton = (name, title, onclick, cls = "") => button(null, { icon: name, title, onclick, class: `icon-only ${cls}` });

/** 75.25 -> "01:15.25", hours when needed. */
export function clock(t, decimals = 2) {
  const safe = Math.max(0, t || 0);
  const scale = 10 ** decimals;
  const total = Math.round(safe * scale);
  const s = (total % (60 * scale)) / scale, m = Math.floor(total / (60 * scale)) % 60, hours = Math.floor(total / (3600 * scale));
  const sec = s.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, "0");
  return (hours ? hours + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + sec;
}

/** 75.2 -> "1:15" for compact labels. */
export function short(t) {
  const s = Math.max(0, Math.round(t || 0));
  const hours = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (hours ? hours + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0");
}

export const secs = (s, digits = 1) => (Math.round((s || 0) * 10 ** digits) / 10 ** digits).toFixed(digits);

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(...args); }, ms); };
  wrapped.flush = (...args) => { if (timer) { clearTimeout(timer); timer = null; fn(...args); } };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export { icon };
