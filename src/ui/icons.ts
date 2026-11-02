/** One outline icon set: 24×24 grid, 1.8 stroke, round caps. Decorative — buttons carry the label. */
const PATHS: Record<string, string> = {
  paragraph: '<path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
  h1: '<path d="M4 6v12M12 6v12M4 12h8M17 10.5l3-2.5v10"/>',
  h2: '<path d="M4 6v12M12 6v12M4 12h8M16 10a2.2 2.2 0 1 1 4 1.4L16 18h4.5"/>',
  h3: '<path d="M4 6v12M12 6v12M4 12h8M16 8h4l-2.5 3.2a2.6 2.6 0 1 1-1.9 4.5"/>',
  bold: '<path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7zM7 12h6.5a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M18 5h-7M13 19H6M15 5 9 19"/>',
  strike: '<path d="M16 7a3.8 3.8 0 0 0-3.6-2h-1A3.4 3.4 0 0 0 8 8.4c0 1.6 1 2.8 3 3.3M4 12h16M8 17a3.8 3.8 0 0 0 3.6 2h1a3.4 3.4 0 0 0 3.4-3.4c0-.6-.1-1.1-.4-1.6"/>',
  highlight: '<path d="m9 11-4.5 4.5V19h3.5l4.5-4.5M9 11l4.5 4.5M9 11l6.5-6.5a2.1 2.1 0 0 1 3 3L13.5 15.5M4 21h16"/>',
  code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  quote: '<path d="M6 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6"/>',
  ul: '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.8" cy="7" r=".9" fill="currentColor"/><circle cx="4.8" cy="12" r=".9" fill="currentColor"/><circle cx="4.8" cy="17" r=".9" fill="currentColor"/>',
  ol: '<path d="M4 5h1.5v4M4 9h3M4 14.5c0-1 2.8-1 2.8.5 0 1-2.8 2-2.8 3.5h3M10 7h10M10 12h10M10 17h10"/>',
  task: '<rect x="3.5" y="5" width="5" height="5" rx="1"/><path d="m4.5 16 1.5 1.5 2.5-3M11 7.5h9M11 16h9"/>',
  codeblock: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m9.5 10-2 2 2 2M14.5 10l2 2-2 2"/>',
  table: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.5h18M3 14.5h18M9.5 9.5v10M14.5 9.5v10"/>',
  hr: '<path d="M4 12h16"/>',
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9.5 4.5v15M5.5 8h1.5M5.5 11h1.5"/>',
  type: '<path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5"/>',
  focus: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  "file-plus": '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M12 11.5v5M9.5 14h5"/>',
  "folder-open": '<path d="M4.5 19.5h13.2a1.5 1.5 0 0 0 1.4-1l2-6a1.5 1.5 0 0 0-1.4-2H8.6a1.5 1.5 0 0 0-1.4 1l-2.7 8z"/><path d="M4.5 19.5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h3.8l2 2.2h6.2a2 2 0 0 1 2 2v1.8"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  "file-text": '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6M9 9h2"/>',
  pencil: '<path d="M15.5 5.5l3 3M4.5 19.5l1-4.2L16 4.8a2.1 2.1 0 0 1 3 3L8.5 18.3z"/>',
  split: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 4.5v15"/>',
  book: '<path d="M12 7c-1.8-1.6-4.5-2.3-8.5-2.3v13c4 0 6.7.7 8.5 2.3 1.8-1.6 4.5-2.3 8.5-2.3v-13c-4 0-6.7.7-8.5 2.3zM12 7v13"/>',
  subscript: '<path d="m4 6 8 9M12 6l-8 9M16.5 15.5a1.8 1.8 0 1 1 3.3 1L16.5 20H20"/>',
  superscript: '<path d="m4 8 8 9M12 8l-8 9M16.5 5.5a1.8 1.8 0 1 1 3.3 1L16.5 10H20"/>',
  footnote: '<path d="M4 7h10M4 12h10M4 17h6M17.5 5.5l2-1.5v6"/>',
  definition: '<path d="M4 6h9M8 11h12M8 15h12M8 19h8"/><circle cx="4.8" cy="13" r=".9" fill="currentColor"/>',
  "heading-id": '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
  emoji: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4.5 4.5 0 0 0 7 0"/><circle cx="9.3" cy="10" r=".9" fill="currentColor"/><circle cx="14.7" cy="10" r=".9" fill="currentColor"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.6"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>',
  "file-pdf": '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 14.5v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  "row-above": '<rect x="3.5" y="12" width="17" height="7.5" rx="1.5"/><path d="M12 3.5v5.5M9.25 6.25h5.5"/>',
  "row-below": '<rect x="3.5" y="4.5" width="17" height="7.5" rx="1.5"/><path d="M12 15v5.5M9.25 17.75h5.5"/>',
  "col-left": '<rect x="12" y="3.5" width="7.5" height="17" rx="1.5"/><path d="M3.5 12H9M6.25 9.25v5.5"/>',
  "col-right": '<rect x="4.5" y="3.5" width="7.5" height="17" rx="1.5"/><path d="M15 12h5.5M17.75 9.25v5.5"/>',
  "row-delete": '<rect x="3.5" y="8.25" width="17" height="7.5" rx="1.5"/><path d="m10.25 10.25 3.5 3.5M13.75 10.25l-3.5 3.5"/>',
  "col-delete": '<rect x="8.25" y="3.5" width="7.5" height="17" rx="1.5"/><path d="m10.25 10.25 3.5 3.5M13.75 10.25l-3.5 3.5"/>',
  trash: '<path d="M4.5 7h15M10 4h4M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12M10 11v5.5M14 11v5.5"/>',
  chevron: '<path d="m7 9.5 5 5 5-5"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
};

/** The app mark (the "Highlighter" app icon without its tile): text lines at rest, one held in an amber stroke. */
export const LOGO = `<svg class="logo" viewBox="236 292 540 440" aria-hidden="true" focusable="false">
  <rect x="262" y="302" width="420" height="40" rx="20" fill="currentColor" opacity=".25"/>
  <path d="M274 432Q498 418 730 412L708 506Q482 512 248 524Z" fill="#d9a94e" fill-opacity=".62" stroke="#d9a94e" stroke-opacity=".62" stroke-width="16" stroke-linejoin="round"/>
  <rect x="284" y="446" width="380" height="40" rx="20" fill="currentColor"/>
  <rect x="262" y="590" width="500" height="40" rx="20" fill="currentColor" opacity=".25"/>
  <rect x="262" y="682" width="300" height="40" rx="20" fill="currentColor" opacity=".25"/>
</svg>`;

export function icon(name: string, cls = ""): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] ?? ""}</svg>`;
}
