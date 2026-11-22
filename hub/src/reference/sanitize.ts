import { BLOCK, escapeAttr, escapeText, findAll, findElement, hasClass, parseHtml, textContent, type HElement, type HNode } from "./html.js";

/**
 * Pages from the offline reference made safe for every device (CONTRACT "Offline reference", Reading): the article body
 * written again from the parsed tree with only text, structure, tables, figures, lists, code and links. Nothing else
 * survives: no script, style, iframe, form, object, embed, event handler, inline style, class, `javascript:` or `data:`
 * address. Every id is prefixed `ref-`, so a page's ids never meet the app's own (or a global name in a browser).
 */

export interface TocEntry { level: number; id: string; text: string }
export interface PageOptions {
  /** The book's name, for links inside it. */
  book: string;
  /** The page's path in the book, which relative links and images are read against. */
  path: string;
  /** The book has pictures; without them images are left out. */
  images: boolean;
}
export interface CleanPage { title: string; html: string; toc: TocEntry[]; url: string | null }
export interface PageSummary { title: string; text: string; media: string | null }

/** Elements kept, with the attributes each may keep (besides lang, dir and id). */
const KEEP: Record<string, string[]> = {
  a: ["title"], abbr: ["title"], b: [], bdi: [], bdo: [], br: [], cite: [], code: [], data: ["value"], dfn: ["title"], em: [],
  i: [], kbd: [], mark: [], q: [], rp: [], rt: [], ruby: [], s: [], samp: [], small: [], span: [], strong: [], sub: [], sup: [],
  time: ["datetime"], u: [], var: [], wbr: [], del: [], ins: [],
  address: [], article: [], aside: [], blockquote: [], details: [], div: [], footer: [], header: [], h1: [], h2: [], h3: [],
  h4: [], h5: [], h6: [], hgroup: [], hr: [], p: [], pre: [], section: [], summary: [],
  dl: [], dt: [], dd: [], ol: ["start", "reversed", "type"], ul: [], li: ["value"],
  table: [], caption: [], colgroup: ["span"], col: ["span"], thead: [], tbody: [], tfoot: [], tr: [],
  th: ["colspan", "rowspan", "scope", "abbr"], td: ["colspan", "rowspan"],
  figure: [], figcaption: [], img: ["alt", "title", "width", "height"],
};
const VOID_OUT = new Set(["br", "col", "hr", "img", "wbr"]);
/** Left out with everything in them. */
const DROP = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed", "noframes", "template", "svg", "math", "head", "title", "meta", "link", "base", "input", "button", "select", "textarea", "option", "optgroup", "datalist", "output", "progress", "meter", "audio", "video", "source", "track", "canvas", "map", "area", "param", "dialog", "portal", "xmp", "plaintext", "slot", "form"]);
/** Page furniture from the wikis' own skins: edit links, navigation boxes, category lists. */
const FURNITURE = ["mw-editsection", "noprint", "mw-empty-elt", "navbox", "printfooter", "catlinks", "mw-jump-link", "mw-indicators", "mw-cite-backlink"];
const HEADING = /^h[1-6]$/;
/** Picture types /reference/media serves. */
export const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

const NUMBER = /^\d{1,5}$/;
const LANG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;
/** Text attributes: control characters out, at most 500 characters. */
const plainAttr = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);

function hidden(e: HElement): boolean {
  if (e.attrs.has("hidden")) return true;
  const style = (e.attrs.get("style") ?? "").toLowerCase().replace(/\s+/g, "");
  if (/display:none|visibility:hidden/.test(style)) return true;
  const cls = e.attrs.get("class");
  return !!cls && FURNITURE.some((f) => cls.split(/\s+/).includes(f));
}

/** The part of a page that is the article: MediaWiki's content block, else main, else the body. */
export function contentRoot(doc: HElement): HElement {
  return findElement(doc, (e) => e.attrs.get("id") === "mw-content-text")
    ?? findElement(doc, (e) => e.name === "main")
    ?? findElement(doc, (e) => e.name === "body")
    ?? doc;
}

/** A path's segments for a URL: each encoded, the slashes between them kept. */
export function encodePath(p: string): string { return p.split("/").map(encodeURIComponent).join("/"); }

/** The page title a path gives ("Systemd/User_(Español)" is "User (Español)" under Systemd). */
export function titleFromPath(p: string): string { return p.replace(/_/g, " ").trim() || p; }

const BASE = "http://book.invalid/";

/**
 * Where a relative address in a page leads, as a path in the same book and a fragment, or null when it leaves the
 * book. Addresses are read as the reader serves the page (`/content/<book>/<path>`), the way the page's own links are
 * written ("../Systemd" from "Systemd/User").
 */
export function resolveInBook(href: string, from: string, urlName?: string): { path: string; fragment: string | null } | null {
  let u: URL;
  try { u = new URL(href, BASE + encodePath(from)); } catch { return null; }
  if (u.origin !== new URL(BASE).origin) return null;
  let segs = u.pathname.split("/").slice(1);
  // An address from the reader's own root ("/content/<book>/Foo") names a page of this book only.
  if (href.startsWith("/")) {
    if (segs[0] !== "content" || !urlName || segs[1] !== urlName) return null;
    segs = segs.slice(2);
  }
  const decoded = segs.map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const path = decoded.join("/");
  if (!path || /[\u0000-\u001f]/.test(path)) return null;
  let fragment: string | null = null;
  if (u.hash.length > 1) { try { fragment = decodeURIComponent(u.hash.slice(1)); } catch { fragment = u.hash.slice(1); } }
  return { path, fragment };
}

/** The address of a page in the reader on a device: `#/reference/<book>/<path, URL-encoded>`. */
export function readerHref(book: string, path: string): string { return `#/reference/${encodeURIComponent(book)}/${encodeURIComponent(path)}`; }

/** An outside link kept as an https address, or null (another scheme, or not an address at all). */
export function externalHref(href: string): string | null {
  const h = href.trim();
  let u: URL;
  try { u = new URL(h.startsWith("//") ? `https:${h}` : h); } catch { return null; }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function extOf(p: string): string { const m = /\.([A-Za-z0-9]{1,5})$/.exec(p); return m ? m[1].toLowerCase() : ""; }

/** A cleaned id: letters, digits and `_.:-`, prefixed `ref-` so it never meets the app's own. */
export function refId(raw: string): string {
  const s = raw.normalize("NFC").replace(/[^\p{L}\p{N}_.:-]+/gu, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return `ref-${s || "section"}`;
}

/**
 * An image's place in the book, or null when it is left out: a picture from another site (never loaded on its own),
 * a `data:` address, or a type /reference/media does not serve.
 */
function imagePath(e: HElement, from: string, urlName?: string): string | null {
  const src = (e.attrs.get("src") || e.attrs.get("data-src") || "").trim();
  if (!src || SCHEME.test(src) || src.startsWith("//")) return null;
  const r = resolveInBook(src, from, urlName);
  if (!r) return null;
  const ext = extOf(r.path);
  return ext && !MEDIA_TYPES[ext] ? null : r.path;
}

interface Writer { out: string[]; ids: Set<string>; toc: TocEntry[]; opts: PageOptions & { urlName?: string }; depth: number }

function attrsOut(e: HElement, w: Writer, extra: [string, string][] = [], idOverride?: string): string {
  const allowed = KEEP[e.name] ?? [];
  const parts: string[] = [];
  const add = (k: string, v: string) => parts.push(` ${k}="${escapeAttr(v)}"`);
  if (idOverride) add("id", idOverride);
  else {
    const id = e.attrs.get("id");
    const clean = id ? refId(id) : "";
    // A page's ids stay one each: a later element with the same id loses it.
    if (clean && !w.ids.has(clean)) { w.ids.add(clean); add("id", clean); }
  }
  const lang = e.attrs.get("lang");
  if (lang && LANG.test(lang)) add("lang", lang);
  const dir = e.attrs.get("dir")?.toLowerCase();
  if (dir === "ltr" || dir === "rtl" || dir === "auto") add("dir", dir);
  for (const k of allowed) {
    const v = e.attrs.get(k);
    if (v === undefined) continue;
    if (["colspan", "rowspan", "span", "start", "value", "width", "height"].includes(k)) {
      if (k === "value" && e.name === "data") add(k, plainAttr(v));
      else if (NUMBER.test(v.trim())) add(k, v.trim());
    } else if (k === "type") { if (/^[1aAiI]$/.test(v)) add(k, v); }
    else if (k === "scope") { if (/^(row|col|rowgroup|colgroup)$/.test(v)) add(k, v); }
    else if (k === "reversed") add(k, "");
    else if (k === "datetime") { if (/^[0-9A-Za-z:+.\- ]{1,40}$/.test(v)) add(k, v); }
    else add(k, plainAttr(v));
  }
  for (const [k, v] of extra) add(k, v);
  return parts.join("");
}

function writeChildren(e: HElement, w: Writer): void { for (const c of e.children) writeNode(c, w); }

function writeNode(n: HNode, w: Writer): void {
  if (n.type === "text") { w.out.push(escapeText(n.text)); return; }
  const name = n.name;
  if (DROP.has(name) || hidden(n)) return;
  if (w.depth > 200) { w.out.push(escapeText(textContent(n))); return; }
  w.depth++;
  try {
    if (name === "img") { writeImage(n, w); return; }
    if (name === "a") { writeLink(n, w); return; }
    if (HEADING.test(name)) { writeHeading(n, w); return; }
    if (!KEEP[name] || (name === "span" && !n.attrs.has("lang") && !n.attrs.has("dir") && !n.attrs.has("id"))) { writeChildren(n, w); return; }
    // Collapsed sections (MediaWiki's mobile layout) are shown open: the reader shows the whole article.
    w.out.push(`<${name}${attrsOut(n, w, name === "details" ? [["open", ""]] : [])}>`);
    if (VOID_OUT.has(name)) return;
    writeChildren(n, w);
    w.out.push(`</${name}>`);
  } finally { w.depth--; }
}

function writeHeading(e: HElement, w: Writer): void {
  const level = Number(e.name.slice(1));
  const text = textContent(e, hidden);
  // The heading's own id, else the one MediaWiki put on a span inside it, else its text.
  const raw = e.attrs.get("id") || findElement(e, (x) => !!x.attrs.get("id"))?.attrs.get("id") || text || "section";
  let id = refId(raw);
  for (let k = 2; w.ids.has(id); k++) id = `${refId(raw)}-${k}`;
  w.ids.add(id);
  if ((level === 2 || level === 3) && text) w.toc.push({ level, id, text });
  w.out.push(`<${e.name}${attrsOut(e, w, [], id)}>`);
  // Ids inside a heading are its own; they are not repeated.
  const strip = (x: HElement) => { x.attrs.delete("id"); for (const c of x.children) if (c.type === "element") strip(c); };
  for (const c of e.children) if (c.type === "element") strip(c);
  writeChildren(e, w);
  w.out.push(`</${e.name}>`);
}

function writeImage(e: HElement, w: Writer): void {
  if (!w.opts.images) return;
  const p = imagePath(e, w.opts.path, w.opts.urlName);
  if (!p) return;
  w.out.push(`<img${attrsOut(e, w, [["data-media", p]])}>`);
}

function writeLink(e: HElement, w: Writer): void {
  const href = (e.attrs.get("href") ?? "").trim();
  const open = (extra: [string, string][]) => { w.out.push(`<a${attrsOut(e, w, extra)}>`); writeChildren(e, w); w.out.push("</a>"); };
  if (!href) { writeChildren(e, w); return; }
  if (href.startsWith("#")) {
    let frag = href.slice(1);
    try { frag = decodeURIComponent(frag); } catch { /* as written */ }
    open([["href", readerHref(w.opts.book, w.opts.path)], ["data-book", w.opts.book], ["data-path", w.opts.path], ...(frag ? [["data-fragment", refId(frag)] as [string, string]] : [])]);
    return;
  }
  if (SCHEME.test(href) || href.startsWith("//")) {
    const ext = /^(https?:)?\/\//i.test(href) ? externalHref(href) : null;
    if (!ext) { writeChildren(e, w); return; }
    open([["href", ext], ["rel", "noopener noreferrer"], ["data-external", ""]]);
    return;
  }
  const r = resolveInBook(href, w.opts.path, w.opts.urlName);
  // A link to a picture file (MediaWiki wraps images in one) keeps only what it holds.
  if (!r || MEDIA_TYPES[extOf(r.path)]) { writeChildren(e, w); return; }
  open([["href", readerHref(w.opts.book, r.path)], ["data-book", w.opts.book], ["data-path", r.path], ...(r.fragment ? [["data-fragment", refId(r.fragment)] as [string, string]] : [])]);
}

/** The page's title: its `<title>`, else its first h1, else its path. */
function pageTitle(doc: HElement, path: string): string {
  const t = findElement(doc, (e) => e.name === "title");
  const text = t ? textContent(t) : "";
  if (text) return text.slice(0, 300);
  const h1 = findElement(doc, (e) => e.name === "h1");
  return (h1 ? textContent(h1, hidden) : "").slice(0, 300) || titleFromPath(path);
}

/** The page's address on its original site, from its canonical link, when that is https. */
function canonical(doc: HElement): string | null {
  const l = findElement(doc, (e) => e.name === "link" && (e.attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  const href = l?.attrs.get("href");
  if (!href || !/^https:\/\//i.test(href)) return null;
  return externalHref(href);
}

/** A page from the reader, sanitized: its title, the article's HTML, the h2 and h3 headings and its original address. */
export function cleanPage(raw: string, opts: PageOptions & { urlName?: string }): CleanPage {
  const doc = parseHtml(raw);
  const w: Writer = { out: [], ids: new Set(), toc: [], opts, depth: 0 };
  writeChildren(contentRoot(doc), w);
  return { title: pageTitle(doc, opts.path), html: w.out.join("").trim(), toc: w.toc, url: canonical(doc) };
}

/** Not the article's own text: references' markers, hidden parts, furniture. */
const notProse = (e: HElement) => hidden(e) || (e.name === "sup" && (hasClass(e, "reference") || hasClass(e, "mw-ref"))) || hasClass(e, "mw-ref") || DROP.has(e.name);
const OFF_PROSE = new Set(["table", "figure", "aside", "blockquote", "nav", "header", "footer", "dl", "ul", "ol"]);

/** The first paragraph as plain text (at most 600 characters) and the article's first picture, for link previews. */
export function pageSummary(raw: string, opts: PageOptions & { urlName?: string }): PageSummary {
  const doc = parseHtml(raw);
  const root = contentRoot(doc);
  const inProse = (e: HElement) => { for (let p = e.parent; p && p !== root; p = p.parent) if (OFF_PROSE.has(p.name) || hidden(p)) return false; return true; };
  const paras = findAll(root, (e) => e.name === "p" && inProse(e), 200);
  const texts = paras.map((p) => textContent(p, notProse)).filter(Boolean);
  let text = texts.find((t) => t.length >= 60) ?? texts[0] ?? textContent(root, notProse).slice(0, 2000);
  if (text.length > 600) {
    const cut = text.slice(0, 599);
    const space = cut.lastIndexOf(" ");
    text = `${(space > 400 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
  }
  let media: string | null = null;
  if (opts.images) {
    for (const img of findAll(root, (e) => e.name === "img", 50)) {
      let skip = false;
      for (let p: HElement | null = img; p && p !== root; p = p.parent) if (hidden(p)) { skip = true; break; }
      const width = Number(img.attrs.get("width"));
      if (skip || (Number.isFinite(width) && width > 0 && width < 40)) continue;
      media = imagePath(img, opts.path, opts.urlName);
      if (media) break;
    }
  }
  return { title: pageTitle(doc, opts.path), text, ...(media ? { media } : { media: null }) };
}

/**
 * `s` without the spaces and tabs at the end of each line but the last: what `.replace(/[ \t]+\n/g, "\n")` gave, in one
 * pass. The pattern tried every space of a long run again: an article of 600,000 characters of `<b> </b>` took five
 * seconds, twice that many fourteen (2026-11-22).
 */
export function lineEndsTrimmed(s: string): string {
  const lines = s.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i];
    let e = l.length;
    while (e > 0 && (l[e - 1] === " " || l[e - 1] === "\t")) e--;
    if (e < l.length) lines[i] = l.slice(0, e);
  }
  return lines.join("\n");
}

export interface ArticleText { lead: string; sections: { id: string; level: number; title: string; text: string }[] }

/**
 * A sanitized article as plain text, split at its h2 and h3 headings, for the assistant: paragraphs on lines of their
 * own, list items with "- ", table cells kept apart with " | ", deeper headings as "### " lines.
 */
export function articleText(html: string): ArticleText {
  const doc = parseHtml(html);
  const sections: ArticleText["sections"] = [];
  let buf: string[] = [];
  let lead: string | null = null;
  let cur: { id: string; level: number; title: string } | null = null;
  const flush = () => {
    const text = lineEndsTrimmed(buf.join("")).replace(/\n[ \t]+/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (cur) sections.push({ ...cur, text });
    else lead = text;
    buf = [];
  };
  const walk = (n: HNode, pre: boolean) => {
    if (n.type === "text") { buf.push(pre ? n.text : n.text.replace(/\s+/g, " ")); return; }
    const name = n.name;
    if (name === "h2" || name === "h3") {
      flush();
      cur = { id: n.attrs.get("id") ?? "", level: Number(name.slice(1)), title: textContent(n) };
      return;
    }
    if (/^h[4-6]$/.test(name)) { buf.push(`\n\n### ${textContent(n)}\n`); return; }
    if (name === "img") return;
    // Citation markers ("[1]") are noise in plain text.
    if (name === "sup" && /^\[[^\]]{1,8}\]$/.test(textContent(n))) return;
    if (name === "br") { buf.push("\n"); return; }
    if (name === "li") buf.push("\n- ");
    else if (name === "td" || name === "th") buf.push(" | ");
    else if (name === "tr") buf.push("\n");
    else if (BLOCK.has(name)) buf.push("\n\n");
    for (const c of n.children) walk(c, pre || name === "pre");
    if (BLOCK.has(name) && name !== "li" && name !== "td" && name !== "th") buf.push("\n");
  };
  for (const c of doc.children) walk(c, false);
  flush();
  return { lead: lead ?? "", sections };
}

/** A snippet from the reader's search kept as HTML with only `<b>`, cut to `max` characters of text. */
export function snippetHtml(parts: ({ text: string } | { bold: string })[], max = 300): string {
  let left = max;
  let out = "";
  for (const p of parts) {
    if (left <= 0) break;
    const text = "text" in p ? p.text : p.bold;
    const piece = text.length > left ? `${text.slice(0, left)}…` : text;
    left -= text.length;
    out += "text" in p ? escapeText(piece) : `<b>${escapeText(piece)}</b>`;
  }
  return out.replace(/\s+/g, " ").trim();
}
