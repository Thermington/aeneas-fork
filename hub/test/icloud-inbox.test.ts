import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { ACCOUNT, ago, done, EMAIL, fake, FOLDERS, linked, type Msg } from "./fake-icloud-mail.js";
import { headerValue, INBOX_MAX, inboxFolder, isAutomated, listInboxICloud, messageIds, originalICloud, REFUSED, TEXT_MAX } from "../src/imports/icloud.js";
import { looksLikeHtml, readingText } from "../src/imports/mail-text.js";

const none = () => false;

test("icloud inbox: reads only the Inbox, read-only, and says which messages are in it", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake([
      { uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: { name: "Alex", address: "alex@example.com" }, messageId: "a1@example.com", plain: "Saturday?" },
      { uid: 2, folder: "INBOX", at: ago(200), subject: "Old but still here", from: { address: "pat@example.com" }, plain: "x" },
      { uid: 3, folder: "Archive", at: ago(1), subject: "Archived", from: { address: "a@example.com" }, plain: "x" },
      { uid: 4, folder: "Sent Messages", at: ago(1), subject: "Re: Gutters", from: { address: EMAIL }, plain: "Yes!" },
      { uid: 5, folder: "Junk", at: ago(1), subject: "You won", from: { address: "spam@example.com" }, plain: "x" },
    ]);
    const r = await listInboxICloud(t.hub, ACCOUNT, ago(90), none, none);
    assert.deepEqual(seen.opened, [{ path: "INBOX", readOnly: true }, { path: "Sent Messages", readOnly: true }], "the Inbox, then Sent for the owner's replies, both with EXAMINE, never SELECT");
    assert.deepEqual(r.present, ["7:1:INBOX", "7:2:INBOX"], "every message in the Inbox, however old");
    assert.deepEqual(r.mails.map((m) => m.subject), ["Gutters"], "only the last 90 days are fetched");
    const m = r.mails[0];
    assert.equal(m.id, "7:1:INBOX");
    assert.equal(m.message_id, "a1@example.com", "angle brackets off");
    assert.equal(m.reply_to, null, "Reply-To that is the From address is no warning");
    assert.equal(m.text, "Saturday?");
    assert.equal(r.more, false);
    // Only the calls the read-only client type has, every connection closed.
    assert.equal(seen.connects, 1);
    assert.equal(seen.logouts, 1);
    assert.deepEqual([...new Set(seen.calls)].sort(), ["connect", "download", "fetch", "fetchOne", "list", "logout", "mailboxOpen", "search"]);
    assert.deepEqual(seen.fetches[0], { query: { envelope: true, bodyStructure: true, internalDate: true, headers: ["list-unsubscribe", "list-id", "auto-submitted", "precedence", "authentication-results", "bimi-location", "references", "feedback-id", "x-mailgun-sid", "x-sg-eid", "x-ses-outgoing", "x-mc-user", "x-pm-message-id", "x-msys-api"] }, o: { uid: true } });
  } finally { done(t); }
});

test("icloud inbox: no Inbox folder means nothing can be said to have left it", async () => {
  const t = makeHub();
  try {
    linked(t);
    // The fake lists the same folders for everyone; the helper decides what counts as the Inbox.
    assert.equal(inboxFolder(FOLDERS.filter((f) => f.path !== "INBOX"))?.path, undefined);
    assert.equal(inboxFolder([{ path: "Inbox", flags: new Set() }])?.path, "Inbox", "IMAP's INBOX in any case");
    assert.equal(inboxFolder([{ path: "INBOX", flags: new Set(["\\Noselect"]) }]), null);
  } finally { done(t); }
});

test("icloud inbox: what is known is not fetched again; a known Message-ID under a new id comes back as moved", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake([
      { uid: 1, folder: "INBOX", at: ago(1), subject: "Kept", from: { address: "a@example.com" }, messageId: "k@x", plain: "x" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Back from Archive", from: { address: "a@example.com" }, messageId: "back@x", plain: "x" },
      { uid: 3, folder: "INBOX", at: ago(1), subject: "New", from: { address: "a@example.com" }, messageId: "new@x", plain: "x" },
    ]);
    const r = await listInboxICloud(t.hub, ACCOUNT, ago(90), (id) => id === "7:1:INBOX", (mid) => mid === "back@x");
    assert.deepEqual(r.mails.map((m) => m.subject), ["New"]);
    assert.deepEqual(r.moved, [{ id: "7:2:INBOX", message_id: "back@x" }]);
    assert.equal(seen.calls.filter((c) => c === "download").length, 1, "only the new message's text is fetched");
  } finally { done(t); }
});

test("icloud inbox: newest first, at most INBOX_MAX, the rest next time", async () => {
  const t = makeHub();
  try {
    linked(t);
    const many: Msg[] = Array.from({ length: INBOX_MAX + 20 }, (_, i) => ({ uid: i + 1, folder: "INBOX", at: ago(1), subject: `m${i + 1}`, from: { address: "a@example.com" }, plain: "hi" }));
    const seen = fake(many);
    const since = ago(90);
    const r = await listInboxICloud(t.hub, ACCOUNT, since, none, none);
    assert.equal(seen.searches[1].since, since, "the search for new mail starts at the window");
    assert.equal(r.more, true);
    assert.equal(r.mails.length, INBOX_MAX);
    assert.equal(r.mails[0].subject, `m${INBOX_MAX + 20}`);
    assert.equal(r.present!.length, INBOX_MAX + 20);
  } finally { done(t); }
});

test("icloud inbox: text as a person reads it (from the HTML when there is one), with links written out; a Reply-To that differs is kept; long text cut", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake([
      { uid: 1, folder: "INBOX", at: ago(1), subject: "both", from: { address: "a@example.com" }, plain: "Short.\n\n-- \nAlex", html: "<p>Short.</p>" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "html", from: { address: "a@example.com" }, html: '<p>First</p><p>Second &amp; <a href="https://shop.example/t">last</a></p><img src="https://track.example/p.gif"><script>alert(1)</script>' },
      { uid: 3, folder: "INBOX", at: ago(1), subject: "Your account", from: { name: "Your Bank", address: "alerts@bank.example" }, replyTo: { address: "help@b4nk-support.example" }, plain: "Please confirm." },
      { uid: 4, folder: "INBOX", at: ago(1), subject: "long", from: { address: "a@example.com" }, plain: "word ".repeat(30_000) },
    ]);
    const { mails } = await listInboxICloud(t.hub, ACCOUNT, ago(90), none, none);
    const by = (s: string) => mails.find((m) => m.subject === s)!;
    assert.equal(by("both").text, "Short.", "the HTML, what a mail app shows, when there is one (since 2026-11-19)");
    assert.match(by("both").html!, /<p>Short\.<\/p>/);
    assert.equal(by("html").text, "First\nSecond & last (https://shop.example/t)", "no tags, no script, no image; the link's address shown");
    assert.equal(by("Your account").reply_to, "help@b4nk-support.example");
    assert.equal(by("long").text.length, TEXT_MAX);
  } finally { done(t); }
});

test("icloud inbox: a refused password pauses the mailbox; only the owner's Refresh tries again", async () => {
  const t = makeHub();
  try {
    linked(t);
    let seen = fake([], { password: "zzzz-zzzz-zzzz-zzzz" });
    await assert.rejects(listInboxICloud(t.hub, ACCOUNT, ago(90), none, none), (e: any) => e.status === 422);
    const a = t.hub.connections.get().icloud![0];
    assert.ok(a.refused_at);
    assert.equal(a.last_error, REFUSED);
    seen = fake([]);
    await assert.rejects(listInboxICloud(t.hub, ACCOUNT, ago(90), none, none), (e: any) => e.status === 409);
    await assert.rejects(originalICloud(t.hub, ACCOUNT, "7:1:INBOX"), (e: any) => e.status === 409);
    assert.equal(seen.connects, 0, "no sign-in on its own after a refusal");
    await listInboxICloud(t.hub, ACCOUNT, ago(90), none, none, { owner: true });
    assert.equal(seen.connects, 1);
    assert.equal(t.hub.connections.get().icloud![0].refused_at, null, "a password that works again unpauses it");
  } finally { done(t); }
});

test("icloud inbox: the original fetches one message's whole text, and says when it is gone", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake([{ uid: 4, folder: "Archive", at: ago(3), subject: "Lease", from: { name: "Pat", address: "pat@example.com" }, replyTo: { address: "other@example.com" }, plain: "Hi Robin,\n\nSign by Friday.\n\nPat\n\n> old quote" }]);
    const o = await originalICloud(t.hub, ACCOUNT, "7:4:Archive");
    assert.equal(o!.text, "Hi Robin,\n\nSign by Friday.\n\nPat\n\n> old quote", "nothing taken off");
    assert.equal(o!.reply_to, "other@example.com");
    assert.equal(o!.from.name, "Pat");
    assert.equal(await originalICloud(t.hub, ACCOUNT, "8:4:Archive"), null, "UIDVALIDITY changed");
    assert.equal(await originalICloud(t.hub, ACCOUNT, "7:4:Gone folder"), null);
    assert.equal(await originalICloud(t.hub, ACCOUNT, "7:5:Archive"), null);
    assert.equal(await originalICloud(t.hub, ACCOUNT, "not an id"), null);
    assert.equal(seen.connects, seen.logouts, "every connection closed");
  } finally { done(t); }
});

test("icloud inbox: header helpers take only what they should from hostile headers", () => {
  assert.deepEqual(messageIds("<a@x> <b@y>\r\n <c@z>"), ["a@x", "b@y", "c@z"]);
  assert.deepEqual(messageIds("no ids here"), []);
  assert.equal(messageIds(Array.from({ length: 500 }, (_, i) => `<id${i}@x>`).join(" ")).length, 50, "at most 50");
  assert.deepEqual(messageIds("<has space@x> <ok@x>"), ["ok@x"]);
  assert.equal(headerValue(Buffer.from("References: <a@x>\r\n\t<b@y>\r\nX-Other: 1\r\n"), "references"), "<a@x> <b@y>", "folded lines unfolded");
  assert.equal(headerValue(Buffer.from("X-References: <evil@x>\r\n"), "references"), "", "only the header named");
  assert.equal(headerValue(undefined, "references"), "");
});

test("mail-text: readingText keeps paragraphs, drops invisible padding, prefers the text part", () => {
  assert.equal(readingText(["One\r\n\r\n\r\n\r\nTwo​  "], ["<p>ignored</p>"]), "One\n\nTwo");
  assert.equal(readingText(["  "], ["<div>Only&nbsp;HTML</div>"]), "Only HTML");
});

test("mail-text: a text part that is really HTML is never shown as code", () => {
  // As some senders do: the text part holds a chunk of the HTML.
  const broken = 'Apply for aid now. <!-- Mirror link -->\n<center>\n<table role="presentation"><tr><td><a href="https://x.example/m">View online</a></td></tr></table>\n</center>\nYou can now send your form.';
  assert.equal(looksLikeHtml(broken), true);
  assert.equal(readingText([broken], ["<p>Apply for aid now.</p><p>You can now send your form.</p>"]), "Apply for aid now.\nYou can now send your form.", "the HTML part instead");
  assert.ok(!/<|role=/.test(readingText([broken], [])), "or that text made plain when there is no HTML part");
  assert.equal(looksLikeHtml("Use <br> for a line break, and <p> for a paragraph."), false, "a mail about two tags is text");
});

test("mail-text: a text part flattened to one line is read from the HTML, its lines kept", () => {
  // As iCloud Mail on the web sends it: the text part on one line, the HTML with every line.
  const plain = ["Hi Alex, I'd be glad to meet. I'm free from 2:30 to 4:30 PM today. Monday afternoon works too. Best, Robin"];
  const html = ['<html><body><div><div><br></div></div><div>Hi Alex,</div><div style="font-family:system-ui"><br></div><div>I\'d be glad to meet. I\'m free from 2:30 to 4:30 PM today.&nbsp;</div><div><br></div><div>Monday afternoon works too.&nbsp;</div><div><br></div><div>Best,</div><div>Robin</div></body></html>'];
  const read = readingText(plain, html);
  assert.equal(read, "Hi Alex,\n\nI'd be glad to meet. I'm free from 2:30 to 4:30 PM today.\n\nMonday afternoon works too.\n\nBest,\nRobin");
  // A short text part whose HTML has no more lines stays the text part.
  assert.equal(readingText(["Thanks!"], ["<div>Thanks!</div>"]), "Thanks!");
});

test("mail-text: HTML read for the Mail screen drops hidden text and keeps where links go, the text part's address first", () => {
  // Shaped like a newsletter: a hidden inbox preview, a link in a sentence through a click tracker, and a text part
  // flattened to one line that has the direct addresses.
  const html = ['<html><head><style>.x{display:none}</style></head><body><div style="color:transparent;display:none !important;max-height:0">Preview: doors at noon!</div>'
    + '<p>Hi Friends,</p><p>The show is on May 16th at 7pm.</p><p>Elm Hall <a href="https://track.example/r?u=1"><strong>TICKETS HERE</strong></a></p>'
    + '<p>Take the <a href="https://track.example/r?u=2&amp;s=3">Band Quiz HERE</a> and find your troop.</p><span hidden>for programs only</span>'
    + '<p><a href="mailto:x@band.example">Write to us</a> or <a href="javascript:alert(1)">this</a>.</p></body></html>'];
  const plain = ["Hi Friends, The show is on May 16th at 7pm. Elm Hall TICKETS HERE <https://tickets.example/e/1> Take the Band Quiz HERE  <https://quiz.example> and find your troop."];
  const marked = readingText(plain, html, "marks");
  assert.ok(!marked.includes("Preview") && !marked.includes("for programs only"), "hidden text never shows");
  assert.ok(marked.includes("Elm Hall [TICKETS HERE](https://tickets.example/e/1)"), "the text part's direct address for the same label");
  assert.ok(marked.includes("Take the [Band Quiz HERE](https://quiz.example) and"), marked);
  assert.ok(marked.includes("Write to us or this."), "a link that is not http(s) is only its label");
  // Show original: links as a text part writes them.
  assert.ok(readingText(plain, html).includes("Elm Hall TICKETS HERE (https://tickets.example/e/1)"));
  // With no text part, the HTML's own address (its &amp; read).
  assert.ok(readingText([""], html, "marks").includes("[Band Quiz HERE](https://track.example/r?u=2&s=3)"));
  // The mail cannot forge a link mark with the characters the reader uses for its own.
  assert.ok(!readingText([""], ["<p>a\uE000b\uE001https://x.example\uE002c</p>"], "marks").includes("]("));
});

test("icloud inbox: a mail a system sent is told from a person's", async () => {
  const h = (s: string) => Buffer.from(s.replace(/\n/g, "\r\n"));
  assert.equal(isAutomated(h("References: <a@x>\n"), "alex@example.com"), false);
  assert.equal(isAutomated(h("List-Unsubscribe: <mailto:u@shop.example>\n"), "deals@shop.example"), true);
  assert.equal(isAutomated(h("List-Id: <club.lists.example>\n"), "sam@example.com"), true);
  assert.equal(isAutomated(h("Auto-Submitted: auto-generated\n"), "x@example.com"), true);
  assert.equal(isAutomated(h("Auto-Submitted: no\n"), "x@example.com"), false);
  assert.equal(isAutomated(h("Precedence: bulk\n"), "x@example.com"), true);
  // Sent through a bulk-mail service: a shop's notice from store+123@t.shop.example has no list headers, but these.
  assert.equal(isAutomated(h("Feedback-Id: ct_x:s_1:shop\n"), "store+123@t.shop.example"), true);
  assert.equal(isAutomated(h("X-Mailgun-Sid: WyJhIl0=\n"), "store+123@t.shop.example"), true);
  assert.equal(isAutomated(h("X-SG-EID: abc\n"), "news@x.example"), true);
  for (const a of ["no_reply@email.fieldstone.example", "noreply@aid.example", "shipment-tracking@shop.example", "do-not-reply@bank.example", "notifications@app.example"]) assert.equal(isAutomated(undefined, a), true, a);
  for (const a of ["alex@example.com", "noreen@example.com", "replyall@example.com"]) assert.equal(isAutomated(undefined, a), false, a);

  // Through the listing: the headers are read, List-Unsubscribe and List-Id kept for sorting.
  const t = makeHub();
  try {
    linked(t);
    fake([
      { uid: 1, folder: "INBOX", at: ago(1), subject: "Shipped", from: { name: "Shop", address: "shipment-tracking@shop.example" }, plain: "Your package was shipped!" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Hi", from: { name: "Alex", address: "alex@example.com" }, plain: "Lunch?" },
      { uid: 3, folder: "INBOX", at: ago(1), subject: "Sale", from: { address: "deals@shop.example" }, headers: "List-Unsubscribe: <https://shop.example/u>\r\n", plain: "20% off" },
      { uid: 4, folder: "INBOX", at: ago(1), subject: "[club] Saturday", from: { address: "sam@example.com" }, headers: "List-Id: Hiking club <club.lists.example>\r\n", plain: "Who's in?" },
    ]);
    const { mails } = await listInboxICloud(t.hub, ACCOUNT, ago(90), none, none);
    const by = (s: string) => mails.find((m) => m.subject === s)!;
    assert.deepEqual(mails.map((m) => [m.subject, m.automated]).sort(), [["Hi", false], ["Sale", true], ["Shipped", true], ["[club] Saturday", true]]);
    assert.deepEqual([by("Sale").unsubscribe, by("Sale").list_id], [true, null]);
    assert.deepEqual([by("[club] Saturday").unsubscribe, by("[club] Saturday").list_id], [false, "Hiking club <club.lists.example>"]);
    assert.deepEqual([by("Hi").unsubscribe, by("Hi").list_id], [false, null]);
  } finally { done(t); }
});
