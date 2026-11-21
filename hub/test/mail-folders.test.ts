import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, EMAIL, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { shownFolders } from "../src/imports/icloud.js";
import type { MailFolder, MailMessage, MailSummary } from "../src/mail-inbox.js";

// The Mail screen's other folders: Drafts, Sent, Junk, Trash and the owner's own, kept like the Inbox, read-only.
// Made-up mail.

const ALEX = { name: "Alex", address: "alex@example.com" };
const SPAM = { name: "Prize Desk", address: "win@prize.example" };
const mailbox = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(1), subject: "Lunch?", from: ALEX, messageId: "i1@x", plain: "Thursday?" },
  { uid: 1, folder: "Drafts", at: ago(1), subject: "Re: Lunch?", from: { address: EMAIL }, to: [ALEX], messageId: "d1@x", plain: "Thursday works", seen: true },
  { uid: 1, folder: "Sent Messages", at: ago(2), subject: "Photos", from: { address: EMAIL }, to: [{ name: "Sam", address: "sam@example.com" }], messageId: "s1@x", plain: "Here they are.", seen: true },
  { uid: 1, folder: "Junk", at: ago(1), subject: "You won!", from: SPAM, messageId: "j1@x", html: `<p>Claim it <img src="https://prize.example/track.png" width="300" height="200"></p>`, plain: "Claim it" },
  { uid: 2, folder: "Junk", at: ago(200), subject: "Old spam", from: SPAM, messageId: "j0@x", plain: "old" },
  { uid: 1, folder: "Deleted Messages", at: ago(3), subject: "Old newsletter", from: { address: "news@shop.example" }, messageId: "t1@x", plain: "Sale", seen: true },
  { uid: 1, folder: "Archive", at: ago(4), subject: "Archived", from: ALEX, messageId: "a1@x", plain: "Kept" },
];
const get = async <T>(t: TestHub, p: string) => (await (await t.api(p)).json()) as T;

test("mail folders: Drafts, Sent, Junk and Trash are kept and listed in that order, not Archive (Done shows it)", async () => {
  const t = makeHub();
  try {
    linked(t);
    const seen = fake(mailbox());
    await t.api("/mail/refresh", { method: "POST" });
    const list = await get<{ messages: MailSummary[]; folders: MailFolder[] }>(t, "/mail");
    assert.deepEqual(list.folders.map((f) => [f.role, f.count, f.unread]), [["drafts", 1, 0], ["sent", 1, 0], ["junk", 1, 1], ["trash", 1, 0]], "Junk's 200-day-old mail is past the 90 days");
    assert.deepEqual(list.messages.map((m) => m.subject), ["Lunch?"], "the Inbox's list has only Inbox mail");
    assert.ok(seen.opened.every((o) => o.readOnly === true), "every folder opened read-only");
    assert.deepEqual([seen.moves.length, seen.flags.length, seen.appends.length], [0, 0, 0], "nothing written");

    const sent = await get<{ messages: (MailSummary & { to: { address: string }[]; folder_role: string })[] }>(t, `/mail/folders/${list.folders[1].key}`);
    assert.deepEqual(sent.messages.map((m) => [m.subject, m.to.map((x) => x.address), m.mine, m.state]), [["Photos", ["sam@example.com"], true, "folder"]]);

    const junk = await get<{ messages: MailSummary[] }>(t, `/mail/folders/${list.folders[2].key}`);
    const open = await get<MailMessage>(t, `/mail/messages/${junk.messages[0].id}`);
    assert.equal(open.subject, "You won!");
    assert.equal(open.pictures_pending || open.pictures_ask, false, "no web pictures for folder mail");
    assert.doesNotMatch(open.html ?? "", /prize\.example\/track/, "the picture's address is not in the page");
    assert.equal((await t.api("/mail/folders/nope")).status, 404);
  } finally { done(t); }
});

test("mail folders: mail that left a folder goes at the next refresh; unlinking takes the folders too", async () => {
  const t = makeHub();
  try {
    linked(t);
    const msgs = mailbox();
    fake(msgs);
    await t.api("/mail/refresh", { method: "POST" });
    msgs.splice(msgs.findIndex((m) => m.folder === "Deleted Messages"), 1);
    msgs.find((m) => m.folder === "Junk" && m.uid === 1)!.seen = true;
    await t.api("/mail/refresh", { method: "POST" });
    const folders = (await get<{ folders: MailFolder[] }>(t, "/mail")).folders;
    assert.deepEqual(folders.map((f) => [f.role, f.count, f.unread]), [["drafts", 1, 0], ["sent", 1, 0], ["junk", 1, 0], ["trash", 0, 0]], "read in Apple Mail counts");
    await t.api("/modules", { method: "PUT", json: { mail_inbox: false } });
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM folder_mail").get() as { n: number }).n, 0, "switching Mail off deletes folder mail");
    assert.equal((t.hub.mailDb.prepare("SELECT count(*) AS n FROM folders").get() as { n: number }).n, 0);
  } finally { done(t); }
});

test("mail folders: which folders show, by iCloud's marks", () => {
  const f = (path: string, specialUse?: string, flags: string[] = []) => ({ path, specialUse, flags: new Set(flags) });
  assert.deepEqual(shownFolders([f("INBOX"), f("Archive", "\\Archive"), f("Brouillons", "\\Drafts"), f("Envoyés", "\\Sent"), f("Indésirables", "\\Junk"), f("Corbeille", "\\Trash"), f("Taxes"), f("[Gmail]", undefined, ["\\Noselect"]), f("All Mail", "\\All")]),
    [{ path: "Brouillons", role: "drafts" }, { path: "Envoyés", role: "sent" }, { path: "Indésirables", role: "junk" }, { path: "Corbeille", role: "trash" }, { path: "Taxes", role: "own" }]);
});
