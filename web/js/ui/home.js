// Home: import a recording, open a sample, or continue a recent project.

import { h, button, iconButton, short, secs } from "./dom.js";
import { icon } from "./icons.js";
import { t, getLang, errorText } from "../i18n.js";
import { api } from "../api.js";
import { prefButtons, logo } from "./prefs.js";
import { toast, confirmDialog, promptDialog, openMenu } from "./overlay.js";

const OPTIONS_KEY = "takecut.import";
const ACCEPT = "audio/*,video/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.webm,.mp4,.mov,.mkv";
let upload = null; // {name, progress}
const uploadListeners = new Set();

function setUpload(next) {
  upload = next;
  for (const fn of uploadListeners) fn();
}

function importOptions() {
  try { return JSON.parse(localStorage.getItem(OPTIONS_KEY)) || {}; } catch { return {}; }
}

function saveImportOptions(patch) {
  try { localStorage.setItem(OPTIONS_KEY, JSON.stringify({ ...importOptions(), ...patch })); } catch { /* storage blocked */ }
}

/** Upload a recording with the saved options, then open it in the editor. */
export async function importFile(file) {
  if (upload) return;
  if (file.size > 512 * 1024 * 1024) return toast(errorText({ code: "too-large" }), { error: true });
  if (location.hash && location.hash !== "#/") location.hash = "#/";
  const options = importOptions();
  setUpload({ name: file.name, progress: 0 });
  try {
    const res = await api.upload(file, { language: options.language || "auto", model: options.model || null },
      progress => setUpload({ name: file.name, progress }));
    setUpload(null);
    location.hash = `#/p/${res.id}`;
  } catch (err) {
    setUpload(null);
    toast(errorText(err), { error: true, duration: 8000 });
  }
}

const isBusy = p => p.status === "queued" || p.status === "transcribing";

function formatDate(seconds) {
  return new Intl.DateTimeFormat(getLang() === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    .format(new Date(seconds * 1000));
}

export function mountHome(root) {
  let system = null, projects = null, jobs = {}, timer = 0, alive = true, failed = null;
  const el = h("div", { class: "home" });
  root.append(el);
  uploadListeners.add(render);
  render();
  refresh();

  async function refresh() {
    try {
      const [sys, list] = await Promise.all([system ?? api.system(), api.projects()]);
      system = sys;
      projects = list.projects;
      failed = null;
      await Promise.all(projects.filter(p => isBusy(p) && p.job).map(async p => {
        try { jobs[p.id] = await api.job(p.job); } catch { /* job gone after restart */ }
      }));
    } catch (err) {
      failed = err;
    }
    if (!alive) return;
    render();
    clearTimeout(timer);
    if (failed || projects?.some(isBusy)) timer = setTimeout(refresh, failed ? 3000 : 1000);
  }

  function render() {
    el.replaceChildren(
      h("header", { class: "topbar" }, logo(), h("span", { class: "grow" }), ...prefButtons()),
      h("main", { class: "home-main" },
        h("section", { class: "hero" }, heroCopy(), dropzone()),
        recent()),
      footer());
  }

  function heroCopy() {
    const title = h("h1");
    title.innerHTML = t("home.title"); // static, trusted locale string with <em>
    return h("div", { class: "hero-copy" },
      title,
      h("p", null, t("home.subtitle")),
      h("div", { class: "hero-points" },
        h("span", { class: "badge" }, icon("shield"), t("home.point.local")),
        h("span", { class: "badge" }, icon("sparkle"), t("home.point.ai")),
        h("span", { class: "badge" }, icon("language"), t("home.point.bilingual"))));
  }

  function dropzone() {
    const input = h("input", { type: "file", hidden: true, accept: ACCEPT, onchange: e => e.target.files[0] && importFile(e.target.files[0]) });
    const options = importOptions();
    const noFfmpeg = system && !system.ffmpeg;
    const target = upload
      ? h("div", { class: "uploading" },
        h("div", { class: "row" }, h("span", { class: "spinner" }), h("strong", null, t("home.uploading", { name: upload.name }))),
        h("div", { class: "progress" }, h("i", { style: { width: `${Math.round(upload.progress * 100)}%` } })))
      : h("div", {
        class: "dropzone-target", role: "button", tabindex: "0",
        onclick: () => !noFfmpeg && input.click(),
        onkeydown: e => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), input.click()),
        ondragover: e => { e.preventDefault(); e.currentTarget.classList.add("over"); },
        ondragleave: e => e.currentTarget.classList.remove("over"),
      },
      h("div", { class: "big-icon" }, icon("upload")),
      h("strong", null, t("home.drop")),
      h("span", null, t("home.dropHint")));

    const language = h("select", { class: "input", onchange: e => saveImportOptions({ language: e.target.value }) },
      ["auto", "zh", "en"].map(v => h("option", { value: v, selected: (options.language || "auto") === v }, t(`home.lang.${v}`))));
    const models = system?.models ?? [{ name: "small", cached: true }];
    const chosen = options.model || system?.defaultModel || "small";
    const model = h("select", { class: "input", onchange: e => saveImportOptions({ model: e.target.value }) },
      models.map(m => h("option", { value: m.name, selected: m.name === chosen }, t(`home.model.${m.name}`) + (m.cached ? "" : t("home.model.download")))));

    return h("div", { class: "dropzone" },
      input,
      target,
      noFfmpeg && h("div", { class: "import-note", style: { color: "var(--cut)" } }, icon("info"), t("home.noFfmpeg")),
      h("div", { class: "import-options" },
        h("label", { class: "field" }, h("span", { class: "label" }, t("home.language")), language),
        h("label", { class: "field" }, h("span", { class: "label" }, t("home.model")), model)),
      system && h("div", { class: "import-note" }, icon(system.cuda ? "chip" : "info"), system.cuda ? t("home.model.gpu") : t("home.model.cpu")),
      h("div", { class: "samples" },
        h("span", null, t("home.samples")),
        (system?.samples ?? ["zh", "en"]).map(lang => button(t(`home.sample.${lang}`), {
          icon: "sparkle", class: "small", onclick: async () => {
            try { location.hash = `#/p/${(await api.sample(lang)).id}`; } catch (err) { toast(errorText(err), { error: true }); }
          },
        }))));
  }

  function recent() {
    let body;
    if (failed && !projects) body = h("div", { class: "empty-projects" }, errorText(failed));
    else if (!projects) body = h("div", { class: "row faint" }, h("span", { class: "spinner" }), t("editor.loading"));
    else if (!projects.length) body = h("div", { class: "empty-projects" }, t("home.empty"));
    else body = h("div", { class: "projects" }, projects.map(card));
    return h("section", null,
      h("div", { class: "section-head" }, h("h2", null, t("home.recent")), projects?.length ? h("span", { class: "count" }, projects.length) : null),
      body);
  }

  function card(p) {
    const open = () => { location.hash = `#/p/${p.id}`; };
    const job = jobs[p.id];
    let status = null;
    if (isBusy(p)) {
      const stage = job?.stage ?? "queued";
      const pct = stage === "transcribing" && job?.progress ? ` ${Math.round(job.progress * 100)}%` : "";
      status = h("div", { class: "project-status" },
        h("span", null, t(`stage.${stage}`) + pct),
        h("div", { class: "progress" + (stage === "transcribing" ? "" : " indeterminate") },
          h("i", { style: stage === "transcribing" ? { width: `${Math.round((job?.progress ?? 0) * 100)}%` } : null })));
    } else if (p.status === "error") {
      status = h("div", { class: "project-status error" },
        h("span", null, errorText({ code: p.error || "failed" })),
        button(t("home.retry"), {
          icon: "restore", class: "small", onclick: async e => {
            e.stopPropagation();
            try { await api.retranscribe(p.id, { language: p.language || "auto", model: p.model || system?.defaultModel || "small" }); refresh(); }
            catch (err) { toast(errorText(err), { error: true }); }
          },
        }));
    } else {
      const s = p.stats;
      status = h("div", { class: "project-stats" },
        p.sample && h("span", { class: "badge accent" }, t("home.sampleTag")),
        p.detectedLanguage && h("span", { class: "badge" }, p.detectedLanguage === "zh" ? "中文" : p.detectedLanguage === "en" ? "English" : p.detectedLanguage),
        s?.cutSeconds > 0 && h("span", { class: "badge cut" }, t("home.trimmed", { cut: secs(s.cutSeconds) })),
        s && h("span", { class: "badge" }, t("home.final", { dur: short(s.editedDuration) })));
    }
    const more = iconButton("more", t("home.open"), e => {
      e.stopPropagation();
      openMenu(e.currentTarget, [
        { label: t("home.open"), icon: "arrowRight", onclick: open },
        { label: t("home.rename"), icon: "pencil", onclick: () => rename(p) },
        { label: t("home.delete"), icon: "trash", danger: true, onclick: () => remove(p) },
      ]);
    }, "ghost small more");
    return h("div", {
      class: "project", role: "link", tabindex: "0", onclick: open,
      onkeydown: e => e.key === "Enter" && e.target === e.currentTarget && open(),
    },
    h("div", { class: "project-top" },
      h("div", { class: "project-thumb" + (p.sample ? " sample" : "") }, icon(p.sample ? "sparkle" : "note")),
      h("div", { style: { minWidth: "0" } },
        h("div", { class: "project-name" }, p.name),
        h("div", { class: "project-meta" }, [p.duration ? short(p.duration) : null, formatDate(p.updated)].filter(Boolean).join(" · "))),
      more),
    status);
  }

  async function rename(p) {
    const name = await promptDialog({ title: t("home.renameTitle"), value: p.name, confirm: t("home.rename") });
    if (!name || name === p.name) return;
    try { await api.rename(p.id, name); toast(t("toast.renamed")); refresh(); } catch (err) { toast(errorText(err), { error: true }); }
  }

  async function remove(p) {
    const ok = await confirmDialog({ title: t("home.deleteTitle"), message: t("home.deleteConfirm", { name: p.name }), confirm: t("home.delete"), danger: true });
    if (!ok) return;
    try { await api.remove(p.id); toast(t("toast.deleted", { name: p.name })); refresh(); } catch (err) { toast(errorText(err), { error: true }); }
  }

  function footer() {
    return h("footer", { class: "home-foot" },
      h("span", { class: "row" }, icon("shield"), t("home.privacy")),
      system && h("span", { class: "mono" }, t("home.dataDir", { dir: system.dataDir })),
      system && h("span", { class: "mono" }, `Takecut ${system.version}`));
  }

  return {
    destroy() { alive = false; clearTimeout(timer); uploadListeners.delete(render); },
    relocalize: render,
    retheme: render,
  };
}
