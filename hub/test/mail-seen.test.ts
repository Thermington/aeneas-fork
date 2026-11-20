import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import type { MailSummary } from "../src/mail-inbox.js";

// Read and unread: read from the mailbox at refresh, and written to it (only the \Seen flag) on open and Mark unread.

const inbox = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(2), subject: "Read on the phone", from: { name: "Alex", address: "alex@example.com" }, messageId: "a1@x", plain: "Hi.", seen: true },
  { uid: 2, folder: "INBOX", at: ago(1), subject: "Not read yet", from: { name: "Sam", address: "sam@example.com" }, messageId: "s1@x", plain: "Hello." },
];
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages;
const bySubject = async (t: TestHub, s: string) => (await list(t)).find((m) => m.subject === s)!;
const mark = (t: TestHub, id: string, seen: boolean) => t.api(`/mail/messages/${id}/seen`, { method: "POST", json: { seen } });

test("mail seen: read in another mail app shows as read; a refresh follows the mailbox's flag", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = inbox();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal((await bySubject(t, "Read on the phone")).seen, true);
    assert.equal((await bySubject(t, "Not read yet")).seen, false);
    msgs[1].seen = true; // read on the phone since
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal((await bySubject(t, "Not read yet")).seen, true);
  } finally { done(t); }
});

test("mail seen: opening marks it read in iCloud and Mark unread clears it, with only the \\Seen flag", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = inbox();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const m = await bySubject(t, "Not read yet");
    const r = await (await mark(t, m.id, true)).json() as { ok: boolean; synced: boolean };
    assert.deepEqual(r, { ok: true, seen: true, synced: true });
    assert.equal(msgs[1].seen, true, "read in iCloud too");
    assert.equal((await bySubject(t, "Not read yet")).seen, true);
    await mark(t, m.id, false);
    assert.equal(msgs[1].seen, false);
    assert.deepEqual(seen.flags, [{ uid: 2, flags: ["\\Seen"], add: true }, { uid: 2, flags: ["\\Seen"], add: false }], "never another flag");
    assert.ok(seen.opened.filter((o) => o.readOnly === false).every((o) => o.path === "INBOX"));
  } finally { done(t); }
});

test("mail seen: the fence: a different message at the same place is not marked; unknown mail and bad bodies are refused", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = inbox();
    const seen = fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    const m = await bySubject(t, "Not read yet");
    msgs[1].messageId = "someone-else@x";
    const r = await (await mark(t, m.id, true)).json() as { synced: boolean };
    assert.equal(r.synced, false);
    assert.deepEqual(seen.flags, [], "nothing written to iCloud");
    assert.equal((await bySubject(t, "Not read yet")).seen, true, "read on the hub all the same");
    assert.equal((await mark(t, "000000000000000000000000", true)).status, 404);
    assert.equal((await t.api(`/mail/messages/${m.id}/seen`, { method: "POST", json: { seen: "yes" } })).status, 422);
    assert.ok(refuseToolCall("POST", `/mail/messages/${m.id}/seen`), "the assistant cannot mark mail read");
  } finally { done(t); }
});
