// Toasts, modal dialogs and pop-up menus.

import { h, button } from "./dom.js";
import { icon } from "./icons.js";
import { t } from "../i18n.js";

/** A short message at the bottom. `action` adds a button (e.g. Undo). Returns a close function. */
export function toast(message, { action, onAction, error = false, duration = 4500 } = {}) {
  const box = document.getElementById("toasts");
  const el = h("div", { class: "toast" + (error ? " error" : "") },
    h("span", null, message),
    action && h("button", { type: "button", class: "btn small", onclick: () => { onAction?.(); close(); } }, action));
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  const timer = setTimeout(close, duration);
  function close() {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 180);
  }
  return close;
}

/** Open a modal <dialog>. `build(close)` returns {title, body, foot}. Resolves with close(value). */
export function modal(build, { wide = false, onOpen } = {}) {
  return new Promise(resolve => {
    const dialog = h("dialog", { class: "dialog", style: wide ? { width: "min(640px, calc(100vw - 32px))" } : null });
    let result;
    const close = value => { result = value; dialog.close(); };
    const { title, body, foot } = build(close);
    dialog.append(
      h("div", { class: "dialog-head" }, h("h2", null, title),
        button(null, { icon: "x", class: "ghost icon-only small", title: t("common.cancel"), onclick: () => close(undefined) })),
      h("div", { class: "dialog-body" }, body),
      foot && h("div", { class: "dialog-foot" }, foot));
    dialog.addEventListener("close", () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    onOpen?.(dialog);
  });
}

export function confirmDialog({ title, message, confirm, danger = false }) {
  return modal(close => ({
    title,
    body: h("p", { class: "muted" }, message),
    foot: [
      button(t("common.cancel"), { onclick: () => close(false) }),
      button(confirm, { class: danger ? "danger" : "primary", onclick: () => close(true) }),
    ],
  })).then(Boolean);
}

export function promptDialog({ title, value = "", confirm }) {
  let input;
  return modal(close => {
    input = h("input", { class: "input", value, maxlength: "120", onkeydown: e => { if (e.key === "Enter") close(input.value.trim()); } });
    return {
      title,
      body: input,
      foot: [button(t("common.cancel"), { onclick: () => close(null) }), button(confirm, { class: "primary", onclick: () => close(input.value.trim()) })],
    };
  }, { onOpen: () => { input.focus(); input.select(); } }).then(v => v || null);
}

/** A small menu next to `anchor`. items: [{label, icon, onclick, danger}] */
export function openMenu(anchor, items) {
  document.querySelector(".menu")?.remove();
  const menu = h("div", { class: "menu", role: "menu" }, items.map(item =>
    h("button", { type: "button", role: "menuitem", class: item.danger ? "danger" : "", onclick: e => { e.stopPropagation(); close(); item.onclick(); } },
      item.icon && icon(item.icon), item.label)));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(window.innerWidth - m.width - 8, r.right - m.width)) + "px";
  menu.style.top = (r.bottom + m.height + 8 > window.innerHeight ? r.top - m.height - 6 : r.bottom + 6) + "px";
  const away = e => { if (!menu.contains(e.target)) close(); };
  const esc = e => { if (e.key === "Escape") close(); };
  setTimeout(() => { document.addEventListener("pointerdown", away); document.addEventListener("keydown", esc); });
  function close() {
    menu.remove();
    document.removeEventListener("pointerdown", away);
    document.removeEventListener("keydown", esc);
  }
  menu.querySelector("button")?.focus();
  return close;
}
