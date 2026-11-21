import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import type { MailFolder, MailSummary } from "../src/mail-inbox.js";

// Files in drafts (the owner's, and a forwarded mail's), and editing a draft. Made-up mail and files.

const PDF = Buffer.from("%PDF-1.4 made-up tickets");
const ALEX = { name: "Alex", address: "alex@example.com" };
const box = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(1), subject: "Tickets", from: ALEX, messageId: "t1@x", plain: "Here they are.", files: [{ name: "tickets.pdf", type: "application/pdf", bytes: PDF }] },
  { uid: 1, folder: "Drafts", at: ago(1), subject: "Re: Gutters", from: { address: EMAIL }, to: [ALEX], cc: [{ address: "sam@example.com" }], messageId: "d1@x", inReplyTo: "g2@x", references: "<g1@x> <g2@x>", plain: "Saturday wor", seen: true },
];
const ask = (t: TestHub, body: unknown) => t.api("/mail/drafts", { method: "POST", json: body });
const headersOf = (raw: string) => raw.split("\r\n\r\n")[0].split("\r\n");
/** A multipart draft's parts: each one's headers and its base64 body decoded. */
function partsOf(raw: string): { headers: string[]; body: Buffer }[] {
  const boundary = /boundary="([^"]+)"/.exec(raw)![1];
  return raw.split(`--${boundary}`).slice(1, -1).map((p) => {
    const [h, ...b] = p.replace(/^\r\n/, "").split("\r\n\r\n");
    return { headers: h.split("\r\n"), body: Buffer.from(b.join("\r\n\r\n").replace(/\r\n/g, ""), "base64") };
  });
}

test("mail files: the owner's files go in as attachments, names cleaned; the preview lists them and saves nothing", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const files = [{ name: "notes.txt", type: "text/plain", data: Buffer.from("hello").toString("base64") }, { name: "../evil\r\n.pdf", type: "bad type<", data: PDF.toString("base64") }];
    const p = await (await ask(t, { to: "pat@example.com", subject: "Files", text: "Attached.", files, preview: true })).json() as { files: { name: string; size: number }[] };
    assert.deepEqual(p.files, [{ name: "notes.txt", size: 5 }, { name: "_evil.pdf", size: PDF.length }]);
    assert.equal(seen.appends.length, 0);
    await ask(t, { to: "pat@example.com", subject: "Files", text: "Attached.", files });
    const parts = partsOf(seen.appends[0].raw);
    assert.equal(parts.length, 3);
    assert.equal(parts[0].body.toString(), "Attached.");
    assert.ok(parts[1].headers.includes('Content-Disposition: attachment; filename="notes.txt"; filename*=UTF-8\'\'notes.txt'));
    assert.ok(parts[2].headers[0].startsWith("Content-Type: application/octet-stream;"), "a type the hub cannot read");
    assert.deepEqual(parts[2].body, PDF);
    assert.ok(headersOf(seen.appends[0].raw).some((h) => h.startsWith("Content-Type: multipart/mixed;")));
  } finally { done(t); }
});

test("mail files: limits on files", async () => {
  const t = makeHub();
  try {
    linked(t);
    fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const one = { name: "a.txt", data: "aGk=" };
    assert.equal((await ask(t, { to: "pat@example.com", text: "x", files: Array(11).fill(one) })).status, 422, "at most 10");
    assert.equal((await ask(t, { to: "pat@example.com", text: "x", files: [{ name: "a", data: "not base64!" }] })).status, 422);
    assert.equal((await ask(t, { to: "pat@example.com", text: "x", files: [{ name: "big", data: Buffer.alloc(16 * 1024 * 1024).toString("base64") }] })).status, 413, "15 MB together");
  } finally { done(t); }
});

test("mail files: a forward can carry the mail's own attachments, read from the mailbox only when saved", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(box());
    await t.api("/mail/refresh", { method: "POST" });
    const id = ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages.find((m) => m.subject === "Tickets")!.id;
    await ask(t, { forward: id, to: "pat@example.com", text: "FYI", forward_attachments: true, preview: true });
    assert.deepEqual(seen.downloads, [], "a preview reads no file");
    await ask(t, { forward: id, to: "pat@example.com", text: "FYI", forward_attachments: true });
    const parts = partsOf(seen.appends[0].raw);
    assert.equal(parts.length, 2);
    assert.match(parts[1].headers.join("\n"), /filename="tickets\.pdf"/);
    assert.deepEqual(parts[1].body, PDF);
  } finally { done(t); }
});

test("mail drafts: editing a draft saves the new one, keeps its Cc and thread, and moves the old one to Trash", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = box();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const drafts = ((await (await t.api("/mail")).json()) as { folders: MailFolder[] }).folders.find((f) => f.role === "drafts")!;
    const draft = ((await (await t.api(`/mail/folders/${drafts.key}`)).json()) as { messages: MailSummary[] }).messages[0];
    const r = await ask(t, { to: "alex@example.com", subject: "Re: Gutters", text: "Saturday works.", replaces: draft.id });
    assert.equal(r.status, 200);
    const lines = headersOf(seen.appends[0].raw);
    assert.ok(lines.includes("Cc: sam@example.com"), "its Cc goes on");
    assert.ok(lines.includes("In-Reply-To: <g2@x>"), "and its thread");
    assert.equal(msgs.find((m) => m.messageId === "d1@x")!.folder, "Deleted Messages", "the old one in Trash, not erased");
    assert.deepEqual(((await (await t.api(`/mail/folders/${drafts.key}`)).json()) as { messages: MailSummary[] }).messages, [], "out of the hub's Drafts at once");
    const inbox = ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages[0];
    assert.equal((await ask(t, { to: "alex@example.com", text: "x", replaces: inbox.id })).status, 404, "only a draft is replaced");
  } finally { done(t); }
});
