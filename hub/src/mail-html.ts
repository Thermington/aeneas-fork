import { escapeAttr, escapeText, parseHtml, type HElement, type HNode } from "./reference/html.js";

/**
 * A mail's HTML made safe to show on the Mail screen (CONTRACT.md, Mail). The mail is parsed into a tree and written out
 * again from it: only elements and attributes on the lists below survive, so nothing can run, load or submit.
 * - Gone: script, iframe, object, embed, form and its fields, svg, meta, link, base, every `on…` handler, every
 *   `javascript:` or other address that is not http(s) or mailto, and any CSS that loads something (`@import`, `url()`
 *   other than a picture written into the mail, `expression`, `behavior`).
 * - Kept: the layout mail uses (tables, `bgcolor`, `align`, `font`, `center`, inline styles, the mail's own `<style>`
 *   rules), and links (http, https, mailto).
 * - Pictures: one sent inside the mail (`cid:`) is written in as a data: address; a picture on the web is not loaded
 *   by the screen ever. Its address is handed back (`remote`, https only), the hub fetches it (mail-inbox.ts: through
 *   Tor, or on a hub without Tor only when the person asks for that mail's) and writes it in later with `withImages`;
 *   until then the tag has no `src`. A tracking pixel (`unseen`) is not handed back, so it is never fetched.
 *
 * This is the first of three walls. The screen shows the result in an iframe sandboxed without `allow-scripts` (no
 * script runs, whatever got through), and `mailDocument`'s Content-Security-Policy lets the page load nothing but the
 * data: pictures in it.
 */

/** Elements kept as they are, attributes cleaned. Any other element gives way to what is inside it. */
const KEEP = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s", "samp", "section",
  "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul",
  "var", "wbr",
]);
/** Left out with everything inside them. `style` is read separately (its rules, cleaned). */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed", "noframes", "template",
  "svg", "math", "title", "meta", "link", "base", "input", "button", "select", "textarea", "option", "optgroup", "datalist", "output",
  "progress", "meter", "audio", "video", "source", "track", "canvas", "map", "area", "param", "dialog", "portal", "xmp", "plaintext",
  "slot", "form", "picture", "xml",
]);
const VOID_OUT = new Set(["br", "col", "hr", "img", "wbr"]);
/**
 * Attributes any kept element may have (layout and text), besides those below. Not `title`: the screen sets each
 * link's to its real address, and a `title` on something inside the link would be shown in its place (a link to one
 * site whose tooltip names another, 2026-11-20).
 */
const ATTRS = new Set([
  "align", "valign", "bgcolor", "border", "cellpadding", "cellspacing", "color", "colspan", "rowspan", "dir", "face", "height",
  "width", "size", "style", "lang", "class", "id", "role", "span", "start", "type", "nowrap", "summary", "headers", "scope",
]);
/** At most this many web pictures per mail are fetched; the rest stay empty. */
export const IMAGES_MAX = 60;
/** Picture types written into a page, by the bytes at their start (never by what the sender's server calls them). */
const PICTURE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
/** A data: picture longer than this is left out (a mail's whole HTML is capped anyway). */
const DATA_MAX = 3_000_000;
/**
 * A mail's pictures, as written into its HTML, are at most this many characters of data: addresses in all (about 9 MB
 * of pictures); one that would go past it is left out. A picture shown many times is written each time, so without
 * this a mail of 3,000 characters that shows one 2 MB picture a hundred times made 266 MB of HTML (2026-11-20).
 */
export const PICTURE_CHARS_MAX = 12_000_000;

/** Whether a data: picture's bytes are what its label says, so nothing else comes in under a picture's name. */
function truePicture(data: string): boolean {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]{0,64})/.exec(data);
  return !!m && pictureType(Buffer.from(m[2], "base64")) === m[1];
}

/** CSS that loads nothing and escapes nothing: no @import, no url() but a data: picture, no old IE script hooks. */
export function cleanCss(css: string): string {
  const plain = css
    .replace(/[<>\u0000\uE020]/g, " ")
    .replace(/\\/g, "") // CSS escapes could spell a word the checks below look for (u\72l, \65xpression)
    // The page's own class for folding quoted history (body.aeneas-fold): a mail's CSS cannot name it, so it cannot
    // show one text while folded and another unfolded.
    .replace(/aeneas/gi, "x-a")
    .replace(/@import[^;]*;?/gi, "");
  // A data: picture is marked (\uE020) while every other url( goes, then written back as url(.
  return pictureUrlsMarked(withoutFontFaces(plain))
    .replace(/(-webkit-)?image-set\s*\(|url\s*\(/gi, "none(")
    .replace(/expression\s*\(|behavior\s*:|-moz-binding|javascript:/gi, "x-")
    // What was taken out above can leave an @import behind, put together from the pieces around it
    // ("@im@import;port" was "@import" again). This last step takes nothing out, so it cannot.
    .replace(/@import/gi, "@x-import")
    .replace(/\uE020/g, "url");
}

// The two steps below go through the CSS once each. As patterns (`@font-face\s*\{[^}]*\}` and
// `url\s*\(\s*(['"]?)([^'")]*)\1\s*\)`) they searched to the end again from every `@font-face{` or `url(` that was
// never closed, so a mail's style of a few hundred thousand of them held the hub for minutes (2026-11-20).

/** `css` without each `@font-face { \u2026 }` rule. One never closed stays as written (what it loads goes with every url). */
function withoutFontFaces(css: string): string {
  const open = /@font-face\s*\{/gi;
  let out = "";
  let at = 0;
  for (let m = open.exec(css); m; m = open.exec(css)) {
    const close = css.indexOf("}", open.lastIndex);
    if (close < 0) break;
    out += css.slice(at, m.index);
    at = close + 1;
    open.lastIndex = close + 1;
  }
  return out + css.slice(at);
}

/**
 * `css` with each whole `url(\u2026)` (bare or in quotes, to its `)`) replaced: a data: picture by its mark (\uE020 in
 * place of `url`), anything else by `none`. A `url(` that is never closed is left for the caller to defuse.
 */
function pictureUrlsMarked(css: string): string {
  const open = /url\s*\(\s*/gi;
  // The next quote or ")" at or after a place, remembered: every url( up to it ends there.
  const mark = /['")]/g;
  let from = 0;
  let found = -2; // -2: not looked for yet; -1: none at or after `from`
  const next = (pos: number): number => {
    if (pos >= from && (found === -1 || found >= pos)) return found;
    from = pos;
    mark.lastIndex = pos;
    found = mark.exec(css)?.index ?? -1;
    return found;
  };
  let out = "";
  let at = 0;
  for (let m = open.exec(css); m; m = open.exec(css)) {
    const first = css[open.lastIndex];
    const quote = first === "'" || first === '"' ? first : "";
    const start = open.lastIndex + quote.length;
    const stop = next(start);
    if (stop < 0) break; // no quote or ")" from here on: no later url( is closed either
    let end = stop + 1;
    if (quote) {
      if (css[stop] !== quote) continue;
      while (end < css.length && /\s/.test(css[end])) end++;
      if (css[end] !== ")") continue;
      end++;
    } else if (css[stop] !== ")") continue;
    const u = css.slice(start, stop);
    const data = u.length <= DATA_MAX && PICTURE.test(u.trim()) ? u.trim().replace(/\s+/g, "") : "";
    out += css.slice(at, m.index) + (data && truePicture(data) ? `\uE020("${data}")` : "none");
    at = end;
    open.lastIndex = end;
  }
  return out + css.slice(at);
}

/**
 * A mailto: link kept: its address or addresses (at most 10), with its subject and body when it has them, and nothing
 * else. `cc` and `bcc` would add readers the link does not show, `attach` has made mail apps attach a file from the
 * device, and right-to-left marks or control characters would dress one address as another. At most 500 characters
 * (the body goes first, then the subject).
 */
function mailtoHref(h: string): string | null {
  const m = /^mailto:([^?#\s<>"]{1,400})(?:\?([^#\s<>"]{0,4000}))?$/i.exec(h);
  if (!m) return null;
  const read = (v: string, lines = false): string | null => {
    let d: string;
    try { d = decodeURIComponent(v); } catch { return null; }
    return (lines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/ : /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/).test(d) ? null : d;
  };
  const to = read(m[1]);
  if (to === null || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+(,[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+){0,9}$/.test(to)) return null;
  const kept = new Map<string, string>();
  for (const pair of (m[2] ?? "").split("&")) {
    const eq = pair.indexOf("=");
    const key = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    if ((key !== "subject" && key !== "body") || kept.has(key) || eq < 0) continue;
    const value = read(pair.slice(eq + 1), key === "body");
    if (value) kept.set(key, encodeURIComponent(value.slice(0, key === "subject" ? 200 : 1000)));
  }
  const link = (keys: string[]) => `mailto:${to}${keys.some((k) => kept.has(k)) ? `?${keys.filter((k) => kept.has(k)).map((k) => `${k}=${kept.get(k)}`).join("&")}` : ""}`;
  return [link(["subject", "body"]), link(["subject"]), link([])].find((l) => l.length <= 500) ?? null;
}

/** A link kept: http, https or mailto, nothing else (no javascript:, data:, file:). */
export function mailHref(raw: string): string | null {
  const h = raw.trim();
  if (/^mailto:/i.test(h)) return mailtoHref(h);
  let u: URL;
  try { u = new URL(h); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

/**
 * A web picture's address that may be fetched: https, no login in it. An `http:` address is asked for over https
 * instead (most servers have both): plain http could be read and changed on the way, by a Tor exit above all.
 */
function remoteSrc(raw: string): string | null {
  const h = raw.trim().startsWith("//") ? `https:${raw.trim()}` : raw.trim();
  let u: URL;
  try { u = new URL(h); } catch { return null; }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return u.toString();
}

/**
 * A web picture the mail does not mean to be seen, which is how senders learn that a mail was opened (a tracking
 * pixel). It is never fetched; its tag stays, empty. Two kinds:
 * - 1 by 1 or smaller: its `width` and `height`, as attributes or in its own style (the larger where both say), are
 *   both 1 or 0;
 * - hidden by its own style or `hidden` attribute (`display:none`, `visibility:hidden`) with no `class` or `id` a style
 *   rule could show it by. A hidden picture that has one is fetched: mail made for phones hides a second picture that
 *   way and shows it on a narrow screen.
 */
function unseen(e: HElement): boolean {
  // Only the start of its style is read: a pixel's style is short, and a long one must not take long to read.
  const style = (e.attrs.get("style") ?? "").slice(0, 2000).toLowerCase().replace(/\\/g, "").replace(/\s+/g, "");
  const px = (v: string | undefined) => { const m = /^(\d+(?:\.\d+)?)(?:px)?$/.exec((v ?? "").trim().toLowerCase()); return m ? Number(m[1]) : null; };
  const side = (name: string) => {
    const a = px(e.attrs.get(name));
    const s = px(new RegExp(`(?:^|;)${name}:([^;!]*)`).exec(style)?.[1]);
    return a === null ? s : s === null ? a : Math.max(a, s);
  };
  const w = side("width");
  const h = side("height");
  if (w !== null && h !== null && w <= 1 && h <= 1) return true;
  const hidden = e.attrs.has("hidden") || /(?:^|;)(?:display:none|visibility:hidden)/.test(style);
  return hidden && !e.attrs.has("class") && !e.attrs.has("id");
}

export interface CleanMail {
  /** The mail's own CSS rules (cleaned) and its body, ready for mailDocument. */
  html: string;
  /** Web pictures to fetch, in the order `<img data-r="N">` numbers them. */
  remote: string[];
  /** How many characters of `html` are the pictures sent inside the mail, written into it: the rest is its markup. */
  pictures: number;
}

/**
 * Clean one mail's HTML. `cids`: pictures sent inside the mail, by Content-ID (without angle brackets), as data:
 * addresses. Web pictures come out as `<img data-r="N" …>` (no src), N their place in `remote`.
 */
export function cleanMailHtml(raw: string, cids: Map<string, string> = new Map()): CleanMail {
  const doc = parseHtml(raw);
  const remote: string[] = [];
  const styles: string[] = [];
  const out: string[] = [];
  let bodyAttrs = "";
  // Pictures written into the mail (sent inside it, or as data: in its HTML): PICTURE_CHARS_MAX in all.
  let pictures = 0;
  const written = (data: string, rest: string): string => {
    if (pictures + data.length > PICTURE_CHARS_MAX) return `<img${rest}>`;
    pictures += data.length;
    return `<img src="${escapeAttr(data)}"${rest}>`;
  };

  const attrsOf = (e: HElement): string => {
    let s = "";
    const tag = e.name;
    for (const [k, v] of e.attrs) {
      const name = k.toLowerCase();
      if (name === "href") {
        if (tag !== "a") continue;
        const h = mailHref(v);
        if (h) s += ` href="${escapeAttr(h)}"`;
      } else if (name === "src" || name === "alt") {
        continue; // pictures are handled below
      } else if (name === "style") {
        const css = cleanCss(v).trim();
        if (css) s += ` style="${escapeAttr(css)}"`;
      } else if (ATTRS.has(name) && /^[a-z-]{1,20}$/.test(name)) {
        s += ` ${name}="${escapeAttr(v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500))}"`;
      }
    }
    return s;
  };

  const img = (e: HElement): string => {
    const src = (e.attrs.get("src") ?? "").trim();
    const alt = e.attrs.get("alt");
    const rest = attrsOf(e) + (alt ? ` alt="${escapeAttr(alt.slice(0, 500))}"` : "");
    if (/^cid:/i.test(src)) {
      const data = cids.get(src.slice(4).replace(/^<|>$/g, "").trim());
      return data ? written(data, rest) : `<img${rest}>`;
    }
    if (/^data:/i.test(src)) {
      const data = src.length <= DATA_MAX && PICTURE.test(src) ? src.replace(/\s+/g, "") : "";
      return data && truePicture(data) ? written(data, rest) : `<img${rest}>`;
    }
    const url = remoteSrc(src);
    // A tracking pixel is never fetched (unseen): the tag stays, with no picture.
    if (!url || unseen(e)) return `<img${rest}>`;
    let n = remote.indexOf(url);
    if (n < 0 && remote.length < IMAGES_MAX) { remote.push(url); n = remote.length - 1; }
    // data-r first, so withImages finds it by the tag's start, which no text can have (text has its `<` escaped).
    return n < 0 ? `<img${rest}>` : `<img data-r="${n}"${rest}>`;
  };

  const walk = (n: HNode) => {
    if (n.type === "text") { out.push(escapeText(n.text)); return; }
    const name = n.name;
    if (name === "style") {
      styles.push(n.children.map((c) => (c.type === "text" ? c.text : "")).join(""));
      return;
    }
    if (DROP.has(name)) return;
    if (name === "body") bodyAttrs = attrsOf(n);
    if (name === "img") { out.push(img(n)); return; }
    if (!KEEP.has(name)) { n.children.forEach(walk); return; }
    out.push(`<${name}${attrsOf(n)}>`);
    if (VOID_OUT.has(name)) return;
    n.children.forEach(walk);
    out.push(`</${name}>`);
  };
  doc.children.forEach(walk);

  const css = styles.map(cleanCss).join("\n").trim();
  const html = `${css ? `<style>${css}</style>` : ""}<div class="aeneas-mail"${bodyAttrs}>${out.join("")}</div>`;
  return { html, remote, pictures };
}

/**
 * `html` with its fetched web pictures written in: `pictures[N]` a data: address for `<img data-r="N">`, or null. Each
 * picture is checked once, however many tags show it, and the pictures a mail holds stay within PICTURE_CHARS_MAX in
 * all, those already in it counted: a tag past that stays empty.
 */
export function withImages(html: string, pictures: (string | null)[]): string {
  const ok = pictures.map((p) => (p && PICTURE.test(p) ? p : null));
  let room = PICTURE_CHARS_MAX;
  for (const m of html.matchAll(/<img src="data:[^"]*"/g)) room -= m[0].length;
  return html.replace(/<img data-r="(\d+)"/g, (_m, n: string) => {
    const p = ok[Number(n)];
    if (!p || p.length > room) return "<img";
    room -= p.length;
    return `<img src="${escapeAttr(p)}"`;
  });
}

/** A picture's type by its first bytes, or null when it is not a picture a page may show (SVG never: it can hold script). */
export function pictureType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** A picture's bytes as a data: address, or null when they are not a picture. */
export function pictureData(b: Buffer): string | null {
  const type = pictureType(b);
  return type ? `data:${type};base64,${b.toString("base64")}` : null;
}

/**
 * The page the screen shows: the cleaned mail inside a document whose Content-Security-Policy loads nothing but the
 * data: pictures written into it (no script, no font, no request anywhere), links opening outside it, on white the way
 * senders design mail. The body's padding is inside its height (`box-sizing: border-box`): many newsletters give
 * html and body `height: 100%`, and with the padding added on top the page was always a little taller than its frame.
 */
export const MAIL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'";
/**
 * The quoted history a reply carries, as mail apps mark it in HTML: Gmail's `gmail_quote`, Apple Mail's and
 * Thunderbird's `<blockquote type="cite">` (and Thunderbird's line above it), Yahoo's `yahoo_quoted`, and Outlook's
 * `divRplyFwdMsg` with everything after it. The page folds it while its body has `aeneas-fold`; the screen's own code
 * (outside the page, which runs none) shows a button that unfolds it. Kept the same as QUOTE_SELECTOR in web/src/lib/mail.ts.
 */
export const QUOTE_SELECTOR = '.gmail_quote, blockquote[type="cite"], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #divRplyFwdMsg ~ *';
const FOLD_CSS = QUOTE_SELECTOR.split(", ").map((s) => `body.aeneas-fold ${s}`).join(",") + "{display:none!important}";

export function mailDocument(clean: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>html,body{margin:0;padding:0;background:#fff;color:#1f1f1f}body{padding:12px 16px;box-sizing:border-box;font:15px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere;overflow-x:auto}img{max-width:100%;height:auto}table{max-width:100%}${FOLD_CSS}</style></head><body class="aeneas-fold">${clean}</body></html>`;
}
