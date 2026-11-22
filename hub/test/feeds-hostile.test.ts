import { test } from "node:test";
import assert from "node:assert/strict";
import { filmsFromRss } from "../src/imports/letterboxd.js";
import { webPageTitle } from "../src/identify.js";
import { attachmentsShown, decodeEntities, hardBreaks, parseStorage, storageToMarkdown } from "../src/wiki-storage.js";
import { articleText, lineEndsTrimmed } from "../src/reference/sanitize.js";

/**
 * Text the hub reads from elsewhere, besides mail and web pages (test/mail-hostile.test.ts, test/web-hostile.test.ts):
 * the Letterboxd diary feed, a device's web page title (Tech), Confluence pages (the wiki mirror) and offline reference
 * articles (Kiwix). Until 2026-11-22 each had a pattern that searched to the end again from every opening never closed,
 * or tried every space of a long run again: 600,000 characters of `<item>` or `<p>` in the feed took 10 to 21 seconds,
 * of `<!--` in a Confluence page 23, of `<b> </b>` in an article 4, a code block of 300,000 spaces then a letter a
 * minute, and a device's page of `<title` over a second for the 128 KB read of it.
 */

const SIZE = 600_000;
const fill = (unit: string, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** Far above what one pass takes (a fraction of a second), far below what the old patterns took. */
const LIMIT_MS = 5000;
function quick(what: string, run: () => unknown) {
  const t0 = Date.now();
  run();
  const ms = Date.now() - t0;
  assert.ok(ms < LIMIT_MS, `${what} took ${ms} ms`);
}

test("hostile feeds and pages: markup that never closes and long runs of spaces are read in one pass", () => {
  for (const u of ["<item>", "<item>x", "<![CDATA[", "<item><letterboxd:filmTitle>", "<item><description>", "<p>"]) quick(`feed ${u}`, () => filmsFromRss(fill(u)));
  for (const u of ["<p>", "<p>x", "<p><", "<![CDATA[", "<", "&lt;p&gt;"]) {
    quick(`feed review ${u}`, () => filmsFromRss(`<item><letterboxd:filmTitle>x</letterboxd:filmTitle><description>${fill(u)}</description></item>`));
  }
  for (const u of ["<title", "<title x", "<title>", "<title>x<"]) quick(`device page ${u}`, () => webPageTitle(fill(u)));
  for (const u of ["<!--", "<![CDATA[", "<a b=\"", "<a b='x' ", "<b> </b>", "<span> </span>", "<br/>  ", "  \n", "<", "&a"]) {
    quick(`confluence ${u}`, () => storageToMarkdown(fill(u)));
    quick(`confluence pictures ${u}`, () => attachmentsShown(fill(u)));
  }
  // Thousands of elements never closed, then thousands of closing tags that match none of them.
  quick("confluence closing tags", () => parseStorage(`${"<x>".repeat(100_000)}${"</y>".repeat(100_000)}`));
  quick("confluence code of spaces", () => storageToMarkdown(`<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${fill(" ")}x]]></ac:plain-text-body></ac:structured-macro>`));
  quick("confluence pre of spaces", () => storageToMarkdown(`<pre>${fill(" ")}x</pre>`));
  for (const u of ["<b> </b>", " \t", "<p> </p>"]) quick(`reference article ${u}`, () => articleText(fill(u)));
  quick("reference pre of spaces", () => articleText(`<pre>${fill(" ")}x</pre>`));
});

// The one-pass routines against the patterns they replaced, on strings made of the pieces these texts are made of.
// The same well-mixed generator as test/mail-hostile.test.ts.
let seed = 20261123;
const rnd = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const made = (pieces: string[], max: number) => { let s = ""; for (let i = 1 + rnd(max); i > 0; i--) s += pieces[rnd(pieces.length)]; return s; };

// filmsFromRss as it was written until 2026-11-22.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const yearOf = (s: string | undefined) => (s && /^\d{4}$/.test(s.trim()) ? Number(s.trim()) : undefined);
const ratingOf = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0.5 && n <= 5 ? Math.round(n * 2) / 2 : undefined;
};
const oldDecode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const oldTag = (block: string, name: string) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? oldDecode(m[1]).trim() : undefined;
};
function oldFilms(xml: string) {
  const out: unknown[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = oldTag(b, "letterboxd:filmTitle");
    if (!title) continue;
    const day = oldTag(b, "letterboxd:watchedDate");
    const html = oldTag(b, "description") ?? "";
    const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((p) => p[1].replace(/<[^>]+>/g, "").trim()).filter((t) => t && !/^Watched on /.test(t));
    const tmdb = Number(oldTag(b, "tmdb:movieId"));
    out.push({
      title,
      year: yearOf(oldTag(b, "letterboxd:filmYear")),
      watched_on: day && DAY.test(day) ? [day] : [],
      watched: true,
      rating: ratingOf(oldTag(b, "letterboxd:memberRating")),
      ...(oldTag(b, "letterboxd:memberLike") === "Yes" ? { liked: true } : {}),
      ...(paras.length ? { review: paras.join("\n\n") } : {}),
      url: oldTag(b, "link"),
      ...(Number.isInteger(tmdb) && tmdb > 0 ? { tmdb_id: tmdb } : {}),
    });
  }
  return out;
}

test("diary feed: reading it in one pass gives what the patterns gave", () => {
  const fields = ["letterboxd:filmTitle", "letterboxd:filmYear", "letterboxd:watchedDate", "letterboxd:memberRating", "letterboxd:memberLike", "tmdb:movieId", "link", "description"];
  const pieces = ["<item>", "<item>", "</item>", "</item>", "<item", "</item", "<", ">", "<>", "/", " ", "\n", "x", "Film", "2019", "2026-11-01", "3.5", "Yes", "42", "Watched on ",
    "<![CDATA[", "]]>", "<p>", "</p>", "<b>", "</b>", "<p", "&lt;p&gt;", "&lt;/p&gt;", "&lt;", "&amp;", "&#60;", "&#65;", "&quot;", "&apos;", "<descriptionx>", "<linkx>",
    ...fields.flatMap((f) => [`<${f}>`, `</${f}>`, `<${f} a="1">`])];
  let films = 0, reviews = 0;
  for (let i = 0; i < 20_000; i++) {
    // Half of them shaped like the feed's items, with noise inside and between, so many have a film and a review.
    const item = () => `<item><letterboxd:filmTitle>${made(pieces, 3)}</letterboxd:filmTitle>${made(pieces, 6)}<description>${made(pieces, 4)}<p>${made(pieces, 4)}</p>${made(pieces, 4)}</description>${made(pieces, 6)}</item>`;
    const s = i % 2 ? made(pieces, i % 4 === 1 ? 120 : 40) : `${made(pieces, 5)}${item()}${made(pieces, 5)}${i % 3 ? item() : ""}`;
    const want = oldFilms(s);
    assert.deepEqual(filmsFromRss(s), want, JSON.stringify(s));
    films += want.length;
    reviews += want.filter((f) => (f as { review?: string }).review).length;
  }
  assert.ok(films > 10_000 && reviews > 3000, `films ${films}, reviews ${reviews}`);
});

test("device page title: reading it in one pass gives what the pattern gave", () => {
  const pieces = ["<title", "<TITLE", "<title>", "<title a=b>", "<titlex>", "</title>", "</TITLE>", "</titlex>", "</", "<", ">", "x", " ", "\n", "a".repeat(90), "&amp;"];
  let found = 0;
  for (let i = 0; i < 20_000; i++) {
    const s = made(pieces, 30);
    const want = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(s)?.[1];
    assert.equal(webPageTitle(s), want, JSON.stringify(s));
    if (want !== undefined) found++;
  }
  assert.ok(found > 2000, `titles ${found}`);
});

// parseStorage as it was written until 2026-11-22.
function oldParseStorage(src: string) {
  type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[] };
  const root: El = { tag: "#root", attrs: {}, kids: [] };
  const stack: El[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.kids.push(m[1]);
    else if (m[2]) {
      const name = m[2].toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? "");
      const el: El = { tag: m[3].toLowerCase(), attrs, kids: [] };
      top.kids.push(el);
      if (!m[5] && !["br", "hr", "img", "col"].includes(el.tag)) stack.push(el);
    } else if (m[6] !== undefined) top.kids.push(decodeEntities(m[6]));
    else if (m[7]) top.kids.push("<");
  }
  return root;
}

test("Confluence pages: reading them in one pass gives what the patterns gave", () => {
  const pieces = ["<![CDATA[", "]]>", "]]", "<!--", "-->", "<!-->", "<!---->", "<!", "<p>", "</p>", "<P>", "</P >", "<b>", "</b>", "</ b>", "<ac:x a=\"1\">", "</ac:x>", "<ac:x", "</AC:X>",
    "<br/>", "<br>", "<hr />", "<img src=\"y\"/>", "<a href='x'>", "<a b=\"", "</a>", "<", ">", "/", "=", "\"", "'", "&amp;", "&#65;", "&bogus;", "text", " ", "  ", "\n", "\t"];
  for (let i = 0; i < 20_000; i++) {
    const s = made(pieces, i % 4 === 0 ? 120 : 40);
    assert.equal(JSON.stringify(parseStorage(s)), JSON.stringify(oldParseStorage(s)), JSON.stringify(s));
  }
  const spaces = [" ", "  ", "   ", "\n", "a", "\t", " "];
  for (let i = 0; i < 20_000; i++) {
    const s = made(spaces, 30);
    assert.equal(hardBreaks(s), s.replace(/ * {2}\n */g, "  \n"), JSON.stringify(s));
    // A code block's own text, as fence() trims it now and as it did.
    assert.equal(s.replace(/^\n+/, "").trimEnd(), s.replace(/^\n+|\s+$/g, ""), JSON.stringify(s));
  }
  assert.equal(storageToMarkdown("<p>One<br/>  two</p><pre>\n\ncode  \n</pre>"), "One  \ntwo\n\n```\ncode\n```\n");
});

test("reference articles: trimming line ends in one pass gives what the pattern gave", () => {
  const pieces = [" ", "  ", "\t", "\n", "\n\n", "a", " "];
  for (let i = 0; i < 20_000; i++) {
    const s = made(pieces, 30);
    assert.equal(lineEndsTrimmed(s), s.replace(/[ \t]+\n/g, "\n"), JSON.stringify(s));
  }
});
