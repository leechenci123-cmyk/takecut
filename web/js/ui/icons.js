// Line icons drawn on a 24×24 grid (stroke = currentColor). Static markup only.

const P = {
  play: '<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 7.6 20 18M8.6 16.4 20 6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 16V5"/><path d="m7 10 5-5 5 5"/><path d="M5 20h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  language: '<path d="M4 5h8M8 3v2M5.5 5c.8 3 2.8 5.5 5.5 7M10.5 5c-.8 3-2.8 5.5-5.5 7"/><path d="m13 21 4-9 4 9M14.5 18h5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.7.3-1.2.9-1.2 1.6v.4"/><path d="M12 17h.01"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  sparkle: '<path d="M12 3c.6 4.4 2.6 6.4 7 7-4.4.6-6.4 2.6-7 7-.6-4.4-2.6-6.4-7-7 4.4-.6 6.4-2.6 7-7z"/><path d="M19 15.5c.2 1.6 1 2.3 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.2 2.3-.9 2.5-2.5z"/>',
  repeat: '<path d="M17 2.5 20 5.5l-3 3"/><path d="M4 11.5v-2a4 4 0 0 1 4-4h12"/><path d="m7 21.5-3-3 3-3"/><path d="M20 12.5v2a4 4 0 0 1-4 4H4"/>',
  message: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
  stutter: '<path d="M3 18 6.5 6 10 18M4.2 14h4.6"/><path d="M13 18l3.5-12L20 18M14.2 14h4.6"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9.5 2.5h5"/>',
  wind: '<path d="M3 8h10.5a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>',
  fit: '<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>',
  split: '<path d="M12 3v18"/><path d="M5 8h4v8H5M19 8h-4v8h4"/>',
  more: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  note: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  wave: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.5-7 10-7c1.7 0 3.2.5 4.5 1.2M22 12s-3.5 7-10 7c-1.7 0-3.2-.5-4.5-1.2"/><path d="M3 3l18 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><rect x="16" y="14" width="5" height="7" rx="2"/>',
  subtitles: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 13h4M13 13h4M7 16.5h7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  gauge: '<path d="M4.5 18a8 8 0 1 1 15 0"/><path d="m12 14 4-4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  rewind: '<path d="M11 18 4 12l7-6zM20 18l-7-6 7-6z"/>',
};

const SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

export function icon(name, cls = "") {
  const el = document.createElement("span");
  el.className = "icon" + (cls ? " " + cls : "");
  el.innerHTML = SVG + (P[name] ?? P.info) + "</svg>";
  return el;
}

export const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><g fill="#c7f67a"><rect x="5" y="13" width="2.6" height="6" rx="1.3"/><rect x="9.8" y="9" width="2.6" height="14" rx="1.3"/><rect x="14.7" y="5.5" width="2.6" height="21" rx="1.3"/><rect x="19.6" y="10" width="2.6" height="12" rx="1.3"/><rect x="24.4" y="13.5" width="2.6" height="5" rx="1.3"/></g></svg>';
