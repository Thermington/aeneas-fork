import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked } from "./fake-icloud-mail.js";
import { buildMessage, checkedNew, encodeWords, replyFields } from "../src/mail-compose.js";
import type { MailSummary } from "../src/mail-inbox.js";

// Writing mail: drafts saved to the mailbox's Drafts folder, never sent. Made-up mail and addresses.

const ALEX = { name: "Alex", address: "alex@example.com" };
const headersOf = (raw: string) => raw.split("\r\n\r\n")[0].split("\r\n");
const bodyOf = (raw: string) => Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();

test("mail drafts: every header is one line, so nothing written can add a recipient", () => {
  const { raw } = buildMessage({ from: { name: "Robin\r\nBcc: evil@x.example", address: EMAIL }, to: ["alex@example.com"], subject: "Hi\r\nBcc: evil@x.example", text: "Hello" });
  const lines = headersOf(raw.toString());
  assert.equal(lines.filter((l) => /^bcc:/i.test(l)).length, 0, "no Bcc header");
  assert.equal(lines.filter((l) => /^to:/i.test(l)).length, 1);
  assert.equal(lines.find((l) => l.startsWith("Subject:")), "Subject: Hi Bcc: evil@x.example", "the line break is a space");
  assert.equal(lines.find((l) => l.startsWith("From:")), `From: "Robin Bcc: evil@x.example" <${EMAIL}>`);
});

test("mail drafts: the owner's text goes in as typed, and other languages are encoded", () => {
  const text = "Hi Alex,\n\nSaturday works — see you at 10.\n\nRobin ☕";
  const { raw, message_id } = buildMessage({ from: { name: "Zoë", address: EMAIL }, to: ["alex@example.com"], subject: "Café on Saturday", text, in_reply_to: "g1@x", references: ["g0@x", "g1@x"] });
  const s = raw.toString();
  assert.equal(bodyOf(s), text.replace(/\n/g, "\r\n"), "exactly the text, with CRLF line ends");
  const lines = headersOf(s);
  assert.equal(lines.find((l) => l.startsWith("Subject:")), `Subject: ${encodeWords("Café on Saturday")}`);
  assert.match(lines.find((l) => l.startsWith("From:"))!, /^From: =\?UTF-8\?B\?[^?]+\?= <robin@icloud\.example>$/);
  assert.ok(lines.includes("In-Reply-To: <g1@x>"));
  assert.ok(lines.includes("References: <g0@x> <g1@x>"));
  assert.ok(lines.includes("Content-Type: text/plain; charset=utf-8"));
  assert.ok(lines.includes(`Message-ID: <${message_id}>`) && message_id.endsWith("@icloud.example"));
  assert.ok(s.split("\r\n").every((l) => l.length <= 998), "no line too long for mail");
  assert.ok(encodeWords("ä".repeat(200)).split(" ").every((w) => w.length <= 75), "encoded words of at most 75 characters");
});

test("mail drafts: a new mail's recipients are plain addresses only", () => {
  assert.deepEqual(checkedNew({ to: "Alex@Example.com, sam@example.com", subject: "Hi" }), { to: ["alex@example.com", "sam@example.com"], subject: "Hi" });
  for (const bad of ["Evil <evil@x.example>", "alex@example", "alex@example.com\r\nBcc: evil@x.example", "\"a\"@x.example", "a@b.example(comment)"]) {
    assert.throws(() => checkedNew({ to: [bad] }), /not an email address|addresses/, bad);
  }
  assert.throws(() => checkedNew({ to: [] }), /1 to 20/);
  assert.throws(() => checkedNew({ to: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`) }), /1 to 20/);
});

test("mail drafts: a reply goes to the sender's From, never its Reply-To, with one Re:", () => {
  assert.deepEqual(replyFields({ from_address: "Alex@Example.com", subject: "Gutters", message_id: "g2@x", refs: ["g1@x"] }), { to: ["alex@example.com"], subject: "Re: Gutters", in_reply_to: "g2@x", references: ["g1@x", "g2@x"] });
  assert.equal(replyFields({ from_address: "alex@example.com", subject: "RE: Gutters", message_id: null, refs: [] }).subject, "RE: Gutters");
  assert.throws(() => replyFields({ from_address: "not an address", subject: "x", message_id: null, refs: [] }), /no address/);
});

test("mail drafts: preview saves nothing; saving appends one draft to Drafts, built from the kept mail, not the request", async () => {
  const t = makeHub();
  try {
    linked(t);
    t.hub.profile.set({ name: "Robin" });
    const seen = fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Gutters", from: ALEX, replyTo: { address: "collect@evil.example" }, messageId: "g1@x", plain: "Saturday?" }]);
    await t.api("/mail/refresh", { method: "POST" });
    const id = ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages[0].id;
    const ask = (body: unknown) => t.api("/mail/drafts", { method: "POST", json: body });

    const preview = await (await ask({ reply_to: id, text: "Yes, 10 AM.", to: ["evil@x.example"], subject: "Other", preview: true })).json();
    assert.deepEqual(preview, { saved: false, from: { name: "Robin", address: EMAIL }, to: ["alex@example.com"], subject: "Re: Gutters", text: "Yes, 10 AM.", in_reply_to: "g1@x" }, "the request's to and subject are not used");
    assert.equal(seen.appends.length, 0, "a preview saves nothing");

    const before = seen.opened.length;
    const saved = await (await ask({ reply_to: id, text: "Yes, 10 AM." })).json() as { saved: boolean };
    assert.equal(saved.saved, true);
    assert.equal(seen.appends.length, 1);
    const a = seen.appends[0];
    assert.equal(a.path, "Drafts");
    assert.deepEqual(a.flags, ["\\Draft", "\\Seen"]);
    assert.ok(headersOf(a.raw).includes("To: alex@example.com"));
    assert.ok(headersOf(a.raw).includes("In-Reply-To: <g1@x>"));
    assert.equal(bodyOf(a.raw), "Yes, 10 AM.");
    assert.deepEqual(seen.opened.slice(before), [], "no folder opened: nothing there is read or changed");
    assert.ok(!seen.calls.some((c) => /move|flags|expunge|delete/i.test(c)), "nothing else written");

    const fresh = await (await ask({ to: "sam@example.com", subject: "Lunch", text: "Thursday?" })).json() as { to: string[]; saved: boolean };
    assert.deepEqual([fresh.saved, fresh.to], [true, ["sam@example.com"]]);
    assert.equal((await ask({ reply_to: id, text: "  " })).status, 422, "nothing to write");
    assert.equal((await ask({ reply_to: "nope", text: "x" })).status, 404);
    assert.equal((await ask({ to: "sam@example.com", from: "someone@else.example", text: "x" })).status, 422, "only a linked mailbox");
  } finally { done(t); }
});

test("mail drafts: without a linked mailbox there is nowhere to save one", async () => {
  const t = makeHub();
  try {
    await t.api("/modules", { method: "PUT", json: { mail_inbox: true } });
    assert.equal((await t.api("/mail/drafts", { method: "POST", json: { to: "sam@example.com", text: "Hi" } })).status, 409);
  } finally { t.cleanup(); }
});
