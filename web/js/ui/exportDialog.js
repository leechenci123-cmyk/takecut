// Export dialog: audio rendered by the local server with FFmpeg, subtitles built in the browser.
// Both come from the same edit, so their timing matches.

import { h, button, secs, short } from "./dom.js";
import { icon } from "./icons.js";
import { t, errorText } from "../i18n.js";
import { api, waitJob } from "../api.js";
import { modal } from "./overlay.js";
import { buildCues, toSRT, toVTT, toTXT } from "../core/subtitles.js";

const KEY = "takecut.export";
const DEFAULTS = { format: "mp3", loudness: null, denoise: false, sub: "srt", maxChars: 0, strip: false, script: "keep" };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULTS }; }
}

function download(url, name) {
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
}

function segmented(values, current, label, onpick) {
  const seg = h("div", { class: "seg" });
  const draw = value => seg.replaceChildren(...values.map(v => h("button", {
    type: "button", "aria-pressed": String(v === value), onclick: () => { onpick(v); draw(v); },
  }, label(v))));
  draw(current);
  return seg;
}

export function openExport(S, system) {
  const o = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* storage blocked */ } };
  const name = S.project.name;

  return modal(close => {
    const audioStatus = h("div", { class: "export-row" });
    const subStatus = h("div", { class: "export-row" });
    const audioBtn = button(t("export.doAudio"), { icon: "download", class: "primary", onclick: exportAudio });
    const subBtn = button(t("export.doSubs"), { icon: "subtitles", onclick: exportSubs });

    async function exportAudio() {
      audioBtn.disabled = true;
      const bar = h("i");
      const label = h("span");
      audioStatus.replaceChildren(h("span", { class: "spinner" }), label, h("div", { class: "progress grow" }, bar));
      try {
        const { job } = await api.export(S.id, {
          format: o.format, loudness: o.loudness, denoise: o.denoise, sampleRate: S.sampleRate, segments: S.renderList(),
        });
        const done = await waitJob(job, j => {
          label.textContent = t(`stage.${j.stage}`);
          bar.style.width = `${Math.round((j.progress || 0) * 100)}%`;
        });
        if (done.state === "error") throw { code: done.error };
        const url = api.exportUrl(S.id, done.result.file);
        download(url, done.result.file);
        audioStatus.replaceChildren(h("span", { class: "export-result" }, icon("check"), t("export.done", { file: done.result.file })),
          h("a", { href: url, download: done.result.file }, t("export.again")));
      } catch (err) {
        audioStatus.replaceChildren(h("span", { style: { color: "var(--cut)" } }, errorText(err)));
      }
      audioBtn.disabled = false;
    }

    async function exportSubs() {
      subBtn.disabled = true;
      try {
        let text;
        if (o.sub === "txt") {
          text = toTXT(S.words, S.lines, S.edits);
          if (o.script !== "keep") text = (await api.convert([text], o.script)).texts[0];
        } else {
          const cues = buildCues(S.words, S.lines, S.edits, S.plan, { maxChars: o.maxChars, strip: o.strip });
          if (o.script !== "keep" && cues.length) {
            const converted = (await api.convert(cues.map(c => c.text), o.script)).texts;
            cues.forEach((c, k) => { c.text = converted[k]; });
          }
          text = o.sub === "srt" ? "﻿" + toSRT(cues) : toVTT(cues);
        }
        const file = `${name}-takecut.${o.sub}`;
        const url = URL.createObjectURL(new Blob([text], { type: o.sub === "vtt" ? "text/vtt;charset=utf-8" : "text/plain;charset=utf-8" }));
        download(url, file);
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        subStatus.replaceChildren(h("span", { class: "export-result" }, icon("check"), t("export.done", { file })));
      } catch (err) {
        subStatus.replaceChildren(h("span", { style: { color: "var(--cut)" } }, errorText(err)));
      }
      subBtn.disabled = false;
    }

    const loudness = h("select", { class: "input small", onchange: e => { o.loudness = e.target.value ? Number(e.target.value) : null; save(); } },
      [["", "export.loud.off"], ["-16", "export.loud.16"], ["-14", "export.loud.14"]].map(([v, k]) =>
        h("option", { value: v, selected: String(o.loudness ?? "") === v }, t(k))));
    const denoise = h("input", { type: "checkbox", checked: o.denoise, onchange: e => { o.denoise = e.target.checked; save(); } });
    const maxChars = h("input", {
      class: "input small", type: "number", min: "0", max: "200", step: "1", value: String(o.maxChars), style: { width: "72px" },
      onchange: e => { o.maxChars = Math.max(0, Math.min(200, Math.round(Number(e.target.value) || 0))); save(); },
    });
    const strip = h("input", { type: "checkbox", checked: o.strip, onchange: e => { o.strip = e.target.checked; save(); } });
    const hasChinese = S.script === "cjk";
    const script = h("select", { class: "input small", disabled: !system?.opencc, onchange: e => { o.script = e.target.value; save(); } },
      ["keep", "s", "t"].map(v => h("option", { value: v, selected: o.script === v }, t(`export.script.${v}`))));

    return {
      title: t("export.title"),
      body: [
        h("p", { class: "export-summary" }, t("export.summary", { dur: short(S.plan.editedDuration), cut: secs(S.cutSeconds()), n: S.edits.pauses.length })),
        h("section", { class: "export-section" },
          h("h3", null, icon("note"), t("export.audio")),
          h("div", { class: "export-row" }, h("span", null, t("export.format")),
            segmented(["wav", "mp3", "m4a"], o.format, v => v.toUpperCase(), v => { o.format = v; save(); })),
          h("div", { class: "export-row" }, h("span", null, t("export.loudness")), loudness),
          h("label", { class: "check" }, denoise, t("export.denoise")),
          h("div", { class: "export-row" }, audioBtn),
          audioStatus),
        h("section", { class: "export-section" },
          h("h3", null, icon("subtitles"), t("export.subtitles")),
          h("div", { class: "export-row" }, h("span", null, t("export.subFormat")),
            segmented(["srt", "vtt", "txt"], o.sub, v => v.toUpperCase(), v => { o.sub = v; save(); })),
          h("div", { class: "export-row" }, h("span", null, t("export.maxChars")), maxChars, h("span", { class: "faint" }, t("export.charsUnit"))),
          h("label", { class: "check" }, strip, t("export.strip")),
          hasChinese && h("div", { class: "export-row" }, h("span", null, t("export.script")), script),
          h("div", { class: "export-row" }, subBtn),
          subStatus),
        h("p", { class: "faint", style: { fontSize: "12.5px" } }, t("export.note")),
      ],
      foot: button(t("export.close"), { onclick: () => close() }),
    };
  }, { wide: true });
}
