// Editor view: loads a project (or follows its transcription), then lays out the transcript,
// the clean-up / pauses sidebar and the timeline dock around one shared session.

import { h, button, iconButton } from "./dom.js";
import { icon } from "./icons.js";
import { t, errorText } from "../i18n.js";
import { api } from "../api.js";
import { Engine } from "../audio/engine.js";
import { buildPeaks } from "../audio/peaks.js";
import { createSession } from "./session.js";
import { createTranscript } from "./transcript.js";
import { createWaveform } from "./waveform.js";
import { createCleanup } from "./cleanup.js";
import { createPausesPanel } from "./pausesPanel.js";
import { createTransport } from "./transport.js";
import { openExport } from "./exportDialog.js";
import { bindShortcuts, openShortcuts } from "./shortcuts.js";
import { prefButtons } from "./prefs.js";
import { toast, openMenu, modal } from "./overlay.js";

export function mountEditor(root, id) {
  const el = h("div", { class: "editor" });
  root.append(el);
  let S = null, engine = null, peaks = null, data = null, system = null;
  let parts = [], subs = [], unbindKeys = null, alive = true, poll = 0, sidePart = null, mode = "loading";
  const onUnload = () => S?.flush();
  window.addEventListener("beforeunload", onUnload);
  api.system().then(s => { system = s; }).catch(() => {});
  message(h("span", { class: "spinner" }), t("editor.loading"));
  load();

  async function load() {
    clearTimeout(poll);
    try {
      data = await api.project(id);
      if (!alive) return;
      document.title = `${data.project.name} · ${t("app.name")}`;
      if (data.project.status !== "ready") return pending(data);
      message(h("span", { class: "spinner" }), t("editor.decoding"));
      engine ??= new Engine();
      await engine.load(api.audioUrl(id));
      if (!alive) return;
      peaks = buildPeaks(engine.buffer);
      S = createSession(data, engine);
      mode = "ready";
      build();
    } catch (err) {
      if (!alive) return;
      mode = "error";
      message(icon("info"), h("strong", null, errorText(err)),
        button(t("editor.back"), { icon: "chevronLeft", onclick: () => { location.hash = "#/"; } }));
    }
  }

  // ---- states before the editor is ready ------------------------------------------------------
  function message(...nodes) {
    el.replaceChildren(topbar(), h("div", { class: "editor-main", style: { gridTemplateColumns: "1fr" } },
      h("div", { class: "status-card" }, ...nodes)), h("div"));
  }

  function pending(fresh) {
    mode = "pending";
    const p = fresh.project;
    if (p.status === "error") {
      return message(icon("info"), h("strong", null, t("editor.failed")), h("span", { class: "faint" }, errorText({ code: p.error || "failed" })),
        button(t("editor.retranscribe"), { icon: "restore", class: "primary", onclick: retranscribe }));
    }
    const stage = h("strong"), bar = h("i"), progress = h("div", { class: "progress", style: { width: "260px" } }, bar);
    message(h("span", { class: "spinner" }), h("div", { class: "project-name" }, p.name), stage, progress, h("span", { class: "faint" }, t("editor.transcribing")));
    const update = job => {
      const st = job?.stage ?? "queued", transcribing = st === "transcribing";
      stage.textContent = t(`stage.${st}`) + (transcribing && job.progress ? ` ${Math.round(job.progress * 100)}%` : "");
      progress.classList.toggle("indeterminate", !transcribing);
      bar.style.width = transcribing ? `${Math.round((job.progress || 0) * 100)}%` : "";
    };
    update(fresh.job);
    const tick = async () => {
      try {
        const next = await api.project(id);
        if (!alive) return;
        if (next.project.status === "ready") return load();
        if (next.project.status === "error") return pending(next);
        update(next.job);
      } catch { /* server restarting: keep polling */ }
      poll = setTimeout(tick, 800);
    };
    poll = setTimeout(tick, 800);
  }

  // ---- layout -------------------------------------------------------------------------------
  function topbar() {
    const name = data?.project.name ?? "";
    const title = h("input", {
      class: "title-input", value: name, "aria-label": t("home.rename"), style: { width: `${Math.min(360, Math.max(120, name.length * 15 + 30))}px` },
      onkeydown: e => {
        if (e.key === "Enter") e.target.blur();
        if (e.key === "Escape") { e.target.value = data.project.name; e.target.blur(); }
      },
      onchange: e => rename(e.target.value),
    });
    const saveState = h("span", { class: "save-state", dataset: { role: "save" } });
    const undo = iconButton("undo", `${t("editor.undo")} (Ctrl+Z)`, () => S?.undo(), "ghost");
    const redo = iconButton("redo", `${t("editor.redo")} (Ctrl+Shift+Z)`, () => S?.redo(), "ghost");
    undo.dataset.role = "undo";
    redo.dataset.role = "redo";
    const more = iconButton("more", t("editor.retranscribe"), e => openMenu(e.currentTarget, [
      { label: t("editor.retranscribe"), icon: "restore", onclick: retranscribe },
      { label: t("pref.help"), icon: "keyboard", onclick: openShortcuts },
    ]), "ghost");
    const ready = mode === "ready";
    return h("header", { class: "topbar" },
      button(t("editor.back"), { icon: "chevronLeft", class: "ghost collapse-label", onclick: () => { location.hash = "#/"; } }),
      h("span", { class: "divider hide-narrow" }),
      data && title, ready && saveState,
      h("span", { class: "grow" }),
      ready && [undo, redo, h("span", { class: "divider" })],
      ...prefButtons({ onHelp: openShortcuts }),
      data && more,
      ready && button(t("editor.export"), { icon: "download", class: "primary", onclick: () => openExport(S, system) }));
  }

  function refreshTopbar() {
    if (!S) return;
    const save = el.querySelector('[data-role="save"]');
    if (save) {
      save.className = "save-state" + (S.saveState === "failed" ? " failed" : "");
      save.replaceChildren(S.saveState === "saving" ? h("span", { class: "spinner", style: { width: "12px", height: "12px" } }) : icon(S.saveState === "failed" ? "info" : "check"),
        t(S.saveState === "saved" ? "editor.saved" : S.saveState === "saving" ? "editor.saving" : "editor.saveFailed"));
    }
    const undo = el.querySelector('[data-role="undo"]'), redo = el.querySelector('[data-role="redo"]');
    if (undo) undo.disabled = !S.history.canUndo;
    if (redo) redo.disabled = !S.history.canRedo;
  }

  function build() {
    teardownParts();
    const scroll = h("div", { class: "transcript-scroll" });
    const showCut = button(null, {
      icon: S.prefs.showCut ? "eye" : "eyeOff", class: "ghost small icon-only", title: t(S.prefs.showCut ? "editor.hideCut" : "editor.showCut"),
      onclick: () => {
        S.setPref("showCut", !S.prefs.showCut);
        showCut.replaceChildren(icon(S.prefs.showCut ? "eye" : "eyeOff"));
        showCut.title = t(S.prefs.showCut ? "editor.hideCut" : "editor.showCut");
      },
    });
    const transcriptPane = h("section", { class: "transcript-pane" },
      h("div", { class: "pane-head" },
        h("h2", null, t("editor.transcript")), h("span", { class: "count" }, t("editor.lines", { n: S.lines.length })),
        h("span", { class: "grow" }),
        S.words.some(w => w.p != null && w.p < 0.5) && h("span", { class: "faint", title: t("editor.lowHint") }, icon("info")),
        showCut),
      scroll);

    const sideScroll = h("div", { class: "side-scroll" });
    const tabs = h("div", { class: "side-tabs", role: "tablist" });
    const sidePane = h("aside", { class: "side-pane" }, tabs, sideScroll);

    const overview = h("canvas", { class: "overview" });
    const canvas = h("canvas", { class: "wave", "aria-label": t("transport.edited") });
    const ruler = h("div", { class: "ruler" }, [0, 1, 2, 3, 4].map(() => h("span")));
    const transportRow = h("div", { class: "transport" });
    const dock = h("footer", { class: "dock" }, h("div", { class: "timeline" }, overview, h("div", { class: "wave-wrap" }, canvas), ruler), transportRow);

    el.replaceChildren(topbar(), h("div", { class: "editor-main" }, transcriptPane, sidePane), dock);
    const waveform = createWaveform(S, { canvas, overview, ruler, peaks });
    parts.push(createTranscript(S, scroll), waveform, createTransport(S, transportRow, waveform));

    const renderTabs = () => {
      const open = S.suggestions().filter(x => x.status === "open").length;
      tabs.replaceChildren(...[["cleanup", "sparkle", open], ["pauses", "wind", S.edits.pauses.length]].map(([key, ic, n]) =>
        h("button", { type: "button", role: "tab", "aria-selected": String(S.prefs.tab === key), onclick: () => showTab(key) },
          icon(ic), t(`tab.${key}`), n ? h("span", { class: "badge" + (key === "cleanup" ? " accent" : " pause") }, String(n)) : null)));
    };
    const showTab = key => {
      if (S.prefs.tab !== key) S.setPref("tab", key);
      sidePart?.destroy();
      sidePart = key === "pauses" ? createPausesPanel(S, sideScroll) : createCleanup(S, sideScroll);
      sideScroll.scrollTop = 0;
      renderTabs();
    };
    showTab(S.prefs.tab === "pauses" ? "pauses" : "cleanup");

    subs = [
      S.on("save", refreshTopbar), S.on("history", refreshTopbar), S.on("edits", renderTabs),
      S.on("pause", () => { if (S.selectedPause != null && S.prefs.tab !== "pauses") showTab("pauses"); }),
    ];
    refreshTopbar();
    unbindKeys = bindShortcuts(S, { onExport: () => openExport(S, system), onHelp: openShortcuts, waveform });
  }

  function teardownParts() {
    parts.forEach(p => p.destroy?.());
    sidePart?.destroy();
    subs.forEach(off => off());
    unbindKeys?.();
    parts = [];
    subs = [];
    sidePart = null;
    unbindKeys = null;
  }

  // ---- actions --------------------------------------------------------------------------------
  async function rename(value) {
    const name = value.trim();
    if (!name || name === data.project.name) return;
    try {
      const meta = await api.rename(id, name);
      data.project.name = meta.name;
      if (S) S.project.name = meta.name;
      document.title = `${meta.name} · ${t("app.name")}`;
      toast(t("toast.renamed"));
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  }

  async function retranscribe() {
    const sys = system ?? await api.system().catch(() => null);
    const p = data.project;
    let language = p.language || "auto", model = p.model || sys?.defaultModel || "small";
    const ok = await modal(close => ({
      title: t("re.title"),
      body: [
        h("p", { class: "muted" }, t("re.body")),
        h("div", { class: "import-options" },
          h("label", { class: "field" }, h("span", { class: "label" }, t("home.language")),
            h("select", { class: "input", onchange: e => { language = e.target.value; } },
              ["auto", "zh", "en"].map(v => h("option", { value: v, selected: v === language }, t(`home.lang.${v}`))))),
          h("label", { class: "field" }, h("span", { class: "label" }, t("home.model")),
            h("select", { class: "input", onchange: e => { model = e.target.value; } },
              (sys?.models ?? [{ name: "small", cached: true }]).map(m => h("option", { value: m.name, selected: m.name === model },
                t(`home.model.${m.name}`) + (m.cached ? "" : t("home.model.download"))))))),
      ],
      foot: [button(t("common.cancel"), { onclick: () => close(false) }), button(t("re.go"), { class: "primary", onclick: () => close(true) })],
    }));
    if (!ok) return;
    try {
      S?.flush();
      await api.retranscribe(id, { language, model });
      teardownParts();
      S?.stop();
      S = null;
      mode = "pending";
      load();
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  }

  return {
    destroy() {
      alive = false;
      clearTimeout(poll);
      S?.flush();
      S?.stop();
      teardownParts();
      engine?.close();
      window.removeEventListener("beforeunload", onUnload);
    },
    relocalize() {
      if (S) build();
      else load();
    },
    retheme() {
      if (S) { el.querySelector(".topbar")?.replaceWith(topbar()); refreshTopbar(); }
      else el.querySelector(".topbar")?.replaceWith(topbar());
    },
  };
}
