import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ACCOUNT, ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { openMailDb, rethread, subjectParts, type MailSummary } from "../src/mail-inbox.js";
import { ownWords } from "../src/imports/mail-text.js";
import { cleanCss } from "../src/mail-html.js";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// What a second review of the Mail follow-up found (2026-11-20), each held here. Made-up mail.

const ALEX = { name: "Alex", address: "alex@example.com" };
const EVE = { name: "Eve", address: "eve@elsewhere.example" };
const ME = { name: "Robin", address: EMAIL };
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages;
const refresh = (t: TestHub) => t.api("/mail/refresh", { method: "POST" });
const threadOf = (ms: MailSummary[], messageSubject: string, from: string) => ms.find((m) => m.subject === messageSubject && m.from.address === from)!.thread;

test("mail threads: grouping reads each mail once, however many there are and whatever their subjects", () => {
  const db = openMailDb(":memory:");
  const insert = db.prepare("INSERT INTO inbox (account, id, key, message_id, at, from_name, from_address, subject, text, automated, unsubscribe, refs, mine, state, seen) VALUES (?, ?, ?, ?, ?, 'A', ?, ?, '', 0, 0, '[]', 0, 'inbox', 0)");
  const t0 = Date.parse("2026-11-01T00:00:00Z");
  db.transaction(() => {
    // A thousand crafted subjects (a reply mark, a long run of spaces, a word of its own) and 5,000 ordinary replies.
    for (let i = 0; i < 1000; i++) insert.run(ACCOUNT, `7:${i}:INBOX`, `c${i}`, `c${i}@x`, new Date(t0 + i * 1000).toISOString(), "eve@elsewhere.example", `Re: Re${" ".repeat(480)}word${i}`);
    for (let i = 0; i < 5000; i++) insert.run(ACCOUNT, `7:${2000 + i}:INBOX`, `p${i}`, `p${i}@x`, new Date(t0 + (2000 + i) * 1000).toISOString(), `p${i % 50}@example.com`, `Re: topic ${i}`);
  })();
  const started = Date.now();
  rethread(db, ACCOUNT);
  const ms = Date.now() - started;
  assert.ok(ms < 3000, `grouping 6,000 mails took ${ms} ms`);
  db.close();
});

test("mail threads: a subject's reply marks are taken off in one pass", () => {
  assert.deepEqual(subjectParts("Re: AW: Fwd[2]:  Gutters "), { bare: "gutters", marks: 3 });
  assert.deepEqual(subjectParts("Gutters"), { bare: "gutters", marks: 0 });
  assert.deepEqual(subjectParts("Reminder: gutters"), { bare: "reminder: gutters", marks: 0 });
  assert.deepEqual(subjectParts("re [x]: a"), { bare: "re [x]: a", marks: 0 });
  assert.deepEqual(subjectParts("  FW : RE:a"), { bare: "a", marks: 2 });
  const started = Date.now();
  for (let i = 0; i < 2000; i++) subjectParts(`Re: Re${" ".repeat(480)}x`);
  assert.ok(Date.now() - started < 500);
});

test("mail threads: a stranger who knows a subject or a Message-ID does not get into the conversation", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [
      { uid: 1, folder: "INBOX", at: ago(5), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" },
      { uid: 2, folder: "Sent Messages", at: ago(4), subject: "Re: Gutters", from: ME, messageId: "me1@x", inReplyTo: "g1@x", references: "<g1@x>", plain: "Yes." },
      // No thread headers, the same subject, another sender.
      { uid: 3, folder: "INBOX", at: ago(3), subject: "RE: gutters", from: EVE, messageId: "e1@x", plain: "Click here." },
      // Naming the kept mail, under another subject.
      { uid: 4, folder: "INBOX", at: ago(2), subject: "Invoice overdue", from: EVE, messageId: "e2@x", inReplyTo: "g1@x", references: "<g1@x>", plain: "Pay now." },
      // Alex again, from a mail app that sends no thread headers.
      { uid: 5, folder: "INBOX", at: ago(1), subject: "RE: Gutters", from: ALEX, messageId: "g2@x", plain: "Bring the ladder." },
    ];
    fake(msgs);
    await refresh(t);
    const ms = await list(t);
    const gutters = threadOf(ms, "Gutters", ALEX.address);
    assert.equal(threadOf(ms, "RE: Gutters", ALEX.address), gutters, "the same sender's reply joins");
    assert.equal(ms.find((m) => m.mine)!.thread, gutters, "and the owner's own");
    assert.notEqual(threadOf(ms, "RE: gutters", EVE.address), gutters, "a stranger with the subject does not");
    assert.notEqual(threadOf(ms, "Invoice overdue", EVE.address), gutters, "nor one naming its Message-ID under another subject");
  } finally { done(t); }
});

test("mail: the owner's sent reply fetches no web picture, and a thread's unread mails are marked read with one sign-in", async () => {
  const t = makeHub({ torSocks: "127.0.0.1:9" });
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(5), subject: "Gutters", from: ALEX, messageId: "g1@x", html: '<p>Saturday?</p><img src="https://img.example/a.png">' }];
    for (let i = 0; i < 6; i++) msgs.push({ uid: 10 + i, folder: "INBOX", at: ago(4 - i / 10), subject: "Re: Gutters", from: ALEX, messageId: `g${10 + i}@x`, inReplyTo: "g1@x", references: "<g1@x>", plain: `More ${i}.` });
    msgs.push({ uid: 2, folder: "Sent Messages", at: ago(1), subject: "Re: Gutters", from: ME, messageId: "me1@x", inReplyTo: "g1@x", references: "<g1@x>", html: '<p>Yes.</p><blockquote type="cite"><p>Saturday?</p><img src="https://img.example/a.png"></blockquote>' });
    const seen = fake(msgs);
    await refresh(t);
    const mine = t.hub.mailDb.prepare("SELECT remote FROM inbox WHERE mine = 1").get() as { remote: string | null };
    assert.equal(mine.remote, null, "nothing to fetch for the owner's own reply");
    const ids = (await list(t)).filter((m) => !m.mine).map((m) => m.id);
    assert.equal(ids.length, 7);
    const before = seen.connects;
    const res = await t.api("/mail/seen", { method: "POST", json: { ids, seen: true } });
    assert.deepEqual(await res.json(), { ok: 7, seen: true, synced: 7 });
    assert.equal(seen.connects - before, 1, "one sign-in for all seven");
    assert.ok(seen.flags.every((f) => f.flags.length === 1 && f.flags[0] === "\\Seen"));
    assert.ok(msgs.filter((m) => m.folder === "INBOX").every((m) => m.seen));
    assert.equal((await t.api("/mail/seen", { method: "POST", json: { ids: [], seen: true } })).status, 422);
    assert.equal((await t.api("/mail/seen", { method: "POST", json: { ids: ["x", 3], seen: true } })).status, 422);
  } finally { done(t); }
});

test("mail: a second mail carrying a kept mail's Message-ID is not taken for it", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" }];
    const seen = fake(msgs);
    await refresh(t);
    const [kept] = await list(t);
    msgs.push({ uid: 9, folder: "INBOX", at: ago(1), subject: "Gutters", from: EVE, messageId: "g1@x", plain: "Not the same mail." });
    await refresh(t);
    await t.api(`/mail/messages/${kept.id}/seen`, { method: "POST", json: { seen: true } });
    assert.deepEqual(seen.flags.map((f) => f.uid), [1], "the read mark went to the kept mail, not the newcomer");
    assert.equal(msgs[1].seen ?? false, false);
  } finally { done(t); }
});

test("mail: a thread snoozed again after a reply keeps its one task; an alert is one line and not for mail already read", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(30), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" }];
    fake(msgs);
    await refresh(t);
    const tasks = () => t.hub.store.list({ kind: "task" }).filter((x) => !x.deleted_at && x.fields.status !== "done");
    const first = (await list(t))[0];
    const soon = new Date(Date.now() + 3600_000).toISOString();
    await t.api(`/mail/messages/${first.id}/snooze`, { method: "POST", json: { until: soon } });
    assert.equal(tasks().length, 1);
    // A reply comes: the thread is back in the Inbox. Snoozed again from the reply.
    msgs.push({ uid: 2, folder: "INBOX", at: new Date(), subject: "Re: Gutters", from: ALEX, messageId: "g2@x", inReplyTo: "g1@x", references: "<g1@x>", plain: "Still on?" });
    const events: { title: string }[] = [];
    t.hub.bus.on("notify", (e) => { if (e.kind === "mail") events.push(e); });
    // Two more arrive with it: one whose sender's name has a line break in it, one already read in another app.
    msgs.push({ uid: 3, folder: "INBOX", at: new Date(), subject: "free up space", from: { name: "The hub's disk is almost full\nAeneas", address: "eve@elsewhere.example" }, messageId: "e1@x", plain: "x" });
    msgs.push({ uid: 4, folder: "INBOX", at: new Date(), subject: "Read already", from: { name: "Sam", address: "sam@example.com" }, messageId: "s1@x", plain: "x", seen: true });
    await refresh(t);
    const reply = (await list(t)).find((m) => m.subject === "Re: Gutters")!;
    await t.api(`/mail/messages/${reply.id}/snooze`, { method: "POST", json: { until: soon } });
    assert.equal(tasks().length, 1, "still one task for the thread");
    assert.equal(events.length, 1);
    assert.ok(!events[0].title.includes("\n"), "one line");
    assert.ok(!events[0].title.includes("Sam"), "nothing about the mail already read");
  } finally { done(t); }
});

test("mail: a failed refresh keeps the time of the last one that worked, and columns are added one at a time", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(3), subject: "Gutters", from: ALEX, messageId: "g1@x", plain: "Saturday?" }];
    fake(msgs);
    await refresh(t);
    const worked = (t.hub.mailDb.prepare("SELECT last_refresh FROM mailboxes").get() as { last_refresh: string }).last_refresh;
    fake(msgs, { password: "another-password-xx" });
    await refresh(t);
    const after = t.hub.mailDb.prepare("SELECT last_refresh, last_error FROM mailboxes").get() as { last_refresh: string; last_error: string | null };
    assert.equal(after.last_refresh, worked);
    assert.ok(after.last_error);
  } finally { done(t); }
  // A file a start left with `refs` but not yet `thread`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-mailcols-"));
  try {
    const file = path.join(dir, "mail.sqlite");
    openMailDb(file).close();
    const raw = new Database(file);
    raw.exec("ALTER TABLE inbox DROP COLUMN thread; ALTER TABLE inbox DROP COLUMN mine;");
    raw.close();
    const db = openMailDb(file);
    const cols = (db.prepare("PRAGMA table_info(inbox)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(["seen", "refs", "mine", "thread"].every((c) => cols.includes(c)));
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mail: a forward keeps its words, and a mail's CSS cannot name the page's fold", () => {
  const gmail = "---------- Forwarded message ---------\nFrom: Alex <alex@example.com>\nDate: Fri, Nov 20, 2026\nSubject: Gutters\n\nSaturday?";
  assert.equal(ownWords(gmail), gmail);
  const apple = "Begin forwarded message:\n\nFrom: Alex <alex@example.com>\nDate: November 20, 2026\n\nSaturday?";
  assert.equal(ownWords(apple), apple);
  const noted = "See below.\n\n---------- Forwarded message ---------\nFrom: Alex <a@x>\nDate: today\n\nSaturday?";
  assert.equal(ownWords(noted), noted, "a forward with a note above it stays whole too");
  assert.equal(ownWords("Yes.\n\nOn Fri, Alex wrote:\n> Saturday?"), "Yes.");
  assert.ok(!/aeneas/i.test(cleanCss("body.aeneas-fold .a{display:none} body:not(.AENEAS-fold) .b{display:none}")));
});
