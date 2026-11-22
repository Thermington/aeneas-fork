import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../src/ai/web.js";

/**
 * A page the assistant reads (web lookups, up to 3 MB) is hostile input, and the hub reads it on its one thread: a page
 * must not be able to hold it. Until 2026-11-22 htmlToText searched to the end of the page again from every `<!--`,
 * `<style`, `<li`, `<title` or `<` that was never closed, so a page of a few hundred thousand of them took minutes
 * (600,000 characters of `<!--`, `<title`, `<li`, `<td` or `<`: each still running after 90 seconds, when it was stopped).
 */

const SIZE = 600_000;
const fill = (unit: string, size = SIZE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
/** Far above what one pass takes (a fraction of a second), far below what the old patterns took (a minute or more). */
const LIMIT_MS = 5000;
function quick(what: string, run: () => unknown) {
  const t0 = Date.now();
  run();
  const ms = Date.now() - t0;
  assert.ok(ms < LIMIT_MS, `${what} took ${ms} ms`);
}

test("hostile page: markup that never closes is read in one pass", () => {
  const units = ["<!--", "<!--a", "<head>", "<head", "<HEAD x", "<title", "<title>", "<TITLE x", "<main", "<main>", "<article x", "<script>", "<style", "<STYLE>",
    "<nav>", "<svg", "<iframe x", "<footer>", "<pre", "<pre>", "<pre>a<b", "<li", "<LI x", "<h1", "<h6 x", "<td", "<th x", "<", "<<", "<a", "<p", "<br ", "<hr  ",
    "&#x", "&#1", "&amp", "&a", "<!--a-->", "<p>a</p>", "<main><pre>", "<article><li>"];
  for (const u of units) {
    const page = fill(u);
    quick(`htmlToText ${u}`, () => htmlToText(page));
  }
  // A long page of ordinary markup is read in one pass too.
  quick("ordinary page", () => htmlToText(fill("<main><h2>Heading</h2><p>Some <b>text</b> &amp; <a href=\"https://e.example/\">a link</a></p><ul><li>one</li></ul><table><tr><td>a</td></tr></table></main>")));
});

// The one-pass routine against the patterns it replaced, on strings made of the pieces pages are made of. The same
// well-mixed generator as test/mail-hostile.test.ts.
let seed = 20261122;
const rnd = (n: number) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const made = (pieces: string[], max: number) => { let s = ""; for (let i = 1 + rnd(max); i > 0; i--) s += pieces[rnd(pieces.length)]; return s; };

// htmlToText as it was written until 2026-11-22, word for word.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "-", ndash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: "(c)", reg: "(r)", trade: "(tm)" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function before(html: string): { title: string; text: string } {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<head\b[\s\S]*?<\/head>/i, " ").replace(/<title\b[\s\S]*?<\/title>/gi, " ");
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].length > 500) body = main[2];
  body = body
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|form|aside)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\`\`\`\n${inner.replace(/<[^>]+>/g, "")}\n\`\`\`\n`)
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/(p|div|section|h[1-6]|li|tr|table|ul|ol|blockquote|dd|dt)>/gi, "\n")
    .replace(/<t[dh]\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  const text = decode(body)
    .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, a) => l || (a[i - 1] ?? "") !== "")
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}

test("web page text: reading a page in one pass gives what the patterns gave", () => {
  // A long run of words, so a page's <main> or <article> is sometimes long enough (over 500 characters) to be read alone.
  const words = "words of a page ".repeat(20);
  const pieces = ["<", ">", "<>", "<<", "<!--", "-->", "--!>", "<!-->", "<!", "</", "/", "\"", "'", "=", "x", "text", " ", "\n", "\t", " ", words, words,
    "<title>", "</title>", "<TITLE a=1>", "<titlex>", "</TITLE>", "<title", "<head>", "</head>", "<HEAD x>", "<header>", "</header>", "<head",
    "<main>", "</main>", "<main class=\"a\">", "<MAIN", "<mainx>", "<article>", "</ARTICLE>", "<article ", "</article>",
    "<script>", "</script>", "<style>", "</Style>", "<noscript>", "</noscript>", "<svg>", "</svg>", "<template>", "</template>", "<iframe x>", "</iframe>",
    "<nav>", "</nav>", "<footer>", "</footer>", "<form>", "</form>", "<aside>", "</aside>",
    "<pre>", "<pre class=x>", "<PRE", "<prex>", "</pre>", "</PRE>", "<code>", "</code>",
    "<br>", "<br/>", "<BR />", "<br", "<hr >", "<hr", "<li>", "<li class=a>", "<LI", "<lix>", "</li>", "<h1>", "<h2 id=a>", "<H6", "<h7>", "<h1x>", "</h3>", "<h",
    "<td>", "<th colspan=2>", "<TD", "<tdx>", "</td>", "<tr>", "</tr>", "<p>", "</p>", "<p", "</div>", "<a href=\"https://e.example/x\">", "</a>",
    "&amp;", "&lt;", "&#65;", "&#x41;", "&#0;", "&#x110000;", "&nbsp;", "&mdash;", "&bogus;", "&", "&#", "&#x", "&amp"];
  let titled = 0, mained = 0, fenced = 0;
  for (let i = 0; i < 20_000; i++) {
    const s = made(pieces, i % 4 === 0 ? 120 : 40);
    const want = before(s);
    assert.deepEqual(htmlToText(s), want, JSON.stringify(s));
    if (want.title) titled++;
    const m = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(s.replace(/<!--[\s\S]*?-->/g, " "));
    if (m && m[2].length > 500) mained++;
    if (want.text.includes("```")) fenced++;
  }
  // The strings reach every kind of step, not only the easy ones.
  assert.ok(titled > 500 && mained > 200 && fenced > 500, `titles ${titled}, main read alone ${mained}, code blocks ${fenced}`);
  assert.deepEqual(htmlToText("<html><head><title>A &amp; B</title></head><body><nav>menu</nav><h2>Hi</h2><p>One<br>two</p><ul><li>x</li></ul><pre><b>code</b></pre></body></html>"),
    { title: "A & B", text: "## Hi\nOne\ntwo\n\n- x\n\n```\ncode\n```" });
});
