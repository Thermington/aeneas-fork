import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { DB } from "./db.js";
import type { Hub } from "./hub.js";
import { icloudInbox, INBOX_DAYS, type FolderListing, type FolderRole, type MailAttachment } from "./imports/icloud.js";
import type { InboxMail, InboxSource, MailAddress } from "./imports/inbox-source.js";

/** Where the Mail screen's mail comes from (imports/inbox-source.ts): iCloud today; a Gmail source is one more entry. */
export const INBOX_SOURCES: InboxSource[] = [icloudInbox];
/** The source an account key belongs to, by its prefix. */
export const sourceOf = (account: string) => INBOX_SOURCES.find((s) => account.startsWith(s.prefix)) ?? null;
import { mailboxLabel } from "./mail-filer.js";
import { errCode } from "./logsafe.js";
import { mailDocument, pictureData, withImages } from "./mail-html.js";
import { ownWords, quoteStart, withoutSignature } from "./imports/mail-text.js";
import { BUNDLE_IDS, BUNDLE_NAMES, bundleContext, bundleOf, currentBundleId, customBundles, NO_MODULES, OLD_BUNDLE_IDS, type BundleContext } from "./mail-bundles.js";
import { fetchBytesViaTor, fetchPublicBytes, postOneClick, TorDown } from "./ai/web.js";
import { StoreError } from "./store.js";
import { textCards, type MailCard } from "./mail-cards.js";
import { blockedForm, isBlocked, unsubscribeWays } from "./mail-unsubscribe.js";
import { readTriage, TRIAGE_BATCH, TRIAGE_DAYS, TRIAGE_SYSTEM, triagePrompt, type Triage } from "./mail-triage.js";
import { assembled, buildMessage, checkedFiles, checkedLine, checkedNew, checkedText, DRAFT_TEXT_MAX, FILES_BYTES, FILES_MAX, forwardQuote, forwardSubject, replyAllCc, type DraftFile, GREETING_SYSTEM, greetingPrompt, plainGreeting, readSuggestion, replyFields } from "./mail-compose.js";
import { withPriority } from "./ai/backends.js";

/**
 * The Mail screen's store (CONTRACT.md, Mail): the iCloud Inbox's mail, sorted into bundles, with what the owner did to
 * each (pinned, snoozed, done).
 *
 * `<data>/mail.sqlite` is a file of its own, like chats.sqlite: the nightly backup copies only hub.sqlite, so mail text
 * never reaches a backup; nothing here is an entity, so nothing is synced to devices; and the assistant's tools, search
 * and memory never read this file. `secure_delete` makes SQLite overwrite what it deletes instead of only marking it
 * free, and big deletes checkpoint the WAL so old pages leave it too.
 *
 * Kept per message, while it is in the Inbox (and while snoozed, however long): mailbox, its folder id, Message-ID, date,
 * the sender's name and address, a Reply-To that differs from From, subject, its text as a person reads it, its HTML
 * cleaned for showing (mail-html.ts) with its pictures written in, whether a system sent it, and the owner's pin, snooze
 * and done. Never other recipients or attachments.
 *
 * Pictures (since 2026-11-19): those sent inside a mail come with it; those on the web are fetched by the hub soon after
 * the mail arrives, every one of them, whether the mail is ever opened or not (fetchMailImages), and only through Tor,
 * as web lookups are (since 2026-11-20). So opening a mail loads nothing, a sender's "opened" tracking says only that
 * the mail was fetched, and the sender's servers see a Tor exit: neither the device's address nor the home's. Pictures a mail marks as one dot or hidden (tracking pixels) are never
 * fetched (mail-html.ts), and only https addresses are.
 *
 * A hub without Tor fetches no web picture on its own. An open mail then offers Show pictures (showPictures): that
 * mail's pictures, fetched straight from the hub because the person asked, after being told that its sender will see
 * the home's internet address. No brand logo is fetched on such a hub.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  message_id TEXT,
  at TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_address TEXT NOT NULL,
  reply_to TEXT,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  automated INTEGER NOT NULL,
  unsubscribe INTEGER NOT NULL,
  list_id TEXT,
  bundle TEXT,
  state TEXT NOT NULL DEFAULT 'inbox',
  pinned INTEGER NOT NULL DEFAULT 0,
  snooze_until TEXT,
  task_id TEXT,
  done_at TEXT,
  html TEXT,
  remote TEXT,
  logo_domain TEXT,
  back_at TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  refs TEXT,
  mine INTEGER NOT NULL DEFAULT 0,
  thread TEXT,
  cards TEXT,
  PRIMARY KEY (account, id)
);
CREATE INDEX IF NOT EXISTS inbox_at ON inbox(at);
CREATE INDEX IF NOT EXISTS inbox_mid ON inbox(account, message_id);
CREATE TABLE IF NOT EXISTS mailboxes (account TEXT PRIMARY KEY, last_refresh TEXT, last_error TEXT, more INTEGER NOT NULL DEFAULT 0, sent_at TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS logos (domain TEXT PRIMARY KEY, url TEXT NOT NULL, svg TEXT, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS folders (account TEXT NOT NULL, path TEXT NOT NULL, key TEXT NOT NULL UNIQUE, role TEXT NOT NULL, more INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, path));
CREATE TABLE IF NOT EXISTS folder_mail (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  folder TEXT NOT NULL,
  message_id TEXT,
  at TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_list TEXT NOT NULL,
  reply_to TEXT,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  automated INTEGER NOT NULL,
  html TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  attachments TEXT,
  PRIMARY KEY (account, id)
);
CREATE INDEX IF NOT EXISTS folder_mail_at ON folder_mail(account, folder, at);
`;

/**
 * The bundles' new ids (2026-11-22): settings kept under an old id move to its successor, and Other's are dropped (its
 * mail is in Updates now, which keeps its own settings). Run at every start; once moved, there is nothing to do.
 */
function renameOldBundles(db: DB): void {
  const read = (key: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const write = (key: string, value: unknown) => db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(value), key);
  const old = (id: string) => id in OLD_BUNDLE_IDS || id === "other";
  try {
    const d = read("bundle_delivery");
    if (d) {
      const all = JSON.parse(d) as Record<string, unknown>;
      if (Object.keys(all).some(old)) {
        const next: Record<string, unknown> = {};
        for (const [id, v] of Object.entries(all)) {
          const to = currentBundleId(id);
          // Other goes; an old id gives way when its successor already has a setting of its own.
          if (id === "other" || (to !== id && to in all)) continue;
          next[to] = v;
        }
        write("bundle_delivery", next);
      }
    }
    const n = read("mail_notify");
    if (n) {
      const notify = JSON.parse(n) as { bundles?: unknown };
      if (Array.isArray(notify.bundles) && notify.bundles.some((b) => typeof b === "string" && old(b))) {
        notify.bundles = [...new Set((notify.bundles as string[]).filter((b) => b !== "other").map(currentBundleId))];
        write("mail_notify", notify);
      }
    }
  } catch { /* a setting that does not read as JSON is left as it is; reading it answers the defaults */ }
}

export function openMailDb(dbPath: string): DB {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 15000");
  db.pragma("secure_delete = ON");
  db.exec(SCHEMA);
  renameOldBundles(db);
  // Since 1.0.10 (the first version shipped): read or unread, and threads. Columns are only added; the next refresh
  // reads each mail's read state, and fills in what kept mail answers (headers only), so pins, snoozes and done stay.
  const inboxCols = (db.prepare("PRAGMA table_info(inbox)").all() as { name: string }[]).map((c) => c.name);
  if (!inboxCols.includes("seen")) db.exec("ALTER TABLE inbox ADD COLUMN seen INTEGER NOT NULL DEFAULT 0");
  // One at a time, each only when it is missing: a start cut short between two of them must not stop the next start.
  if (!inboxCols.includes("refs")) db.exec("ALTER TABLE inbox ADD COLUMN refs TEXT");
  if (!inboxCols.includes("mine")) db.exec("ALTER TABLE inbox ADD COLUMN mine INTEGER NOT NULL DEFAULT 0");
  if (!inboxCols.includes("thread")) db.exec("ALTER TABLE inbox ADD COLUMN thread TEXT");
  // How far each mailbox's Sent folder has been read, so each sent mail is looked at once (icloud.ts).
  if (!(db.prepare("PRAGMA table_info(mailboxes)").all() as { name: string }[]).some((c) => c.name === "sent_at")) db.exec("ALTER TABLE mailboxes ADD COLUMN sent_at TEXT");
  // Cards: mail kept before them has none stored (NULL), and gets the ones its text shows when listed.
  if (!inboxCols.includes("cards")) db.exec("ALTER TABLE inbox ADD COLUMN cards TEXT");
  // Attachments (since 2026-11-21): mail kept before has none listed (NULL) until it is opened.
  if (!inboxCols.includes("attachments")) db.exec("ALTER TABLE inbox ADD COLUMN attachments TEXT");
  // Triage (since 2026-11-21): the model's urgency, summary and needs-reply, kept TRIAGE_DAYS from triaged_at.
  if (!inboxCols.includes("triage")) db.exec("ALTER TABLE inbox ADD COLUMN triage TEXT");
  if (!inboxCols.includes("triaged_at")) db.exec("ALTER TABLE inbox ADD COLUMN triaged_at TEXT");
  // A folding note (since 2026-11-22): the owner said the fold hid something; kept with the mail, never sent anywhere.
  if (!inboxCols.includes("fold_note")) db.exec("ALTER TABLE inbox ADD COLUMN fold_note TEXT");
  // Recipients (since 2026-11-22): To and Cc, for the owner's bundle rules; NULL for mail kept before.
  if (!inboxCols.includes("rcpt")) db.exec("ALTER TABLE inbox ADD COLUMN rcpt TEXT");
  if (!(db.prepare("PRAGMA table_info(folder_mail)").all() as { name: string }[]).some((c) => c.name === "attachments")) db.exec("ALTER TABLE folder_mail ADD COLUMN attachments TEXT");
  return db;
}

const DAY_MS = 86_400_000;
/** A message's id in the API: stays the same when the message moves between folders, and shows nothing of the mail. */
export const mailKey = (account: string, id: string) => crypto.createHash("sha256").update(`${account}\n${id}`).digest("hex").slice(0, 24);

/** Whether a message is kept already by its folder id (the refresh fetches only what is not). */
export function isKept(db: DB, account: string): (id: string) => boolean {
  const has = db.prepare("SELECT 1 FROM inbox WHERE account = ? AND id = ?");
  return (id) => !!has.get(account, id);
}

/** Whether a message is kept already by its Message-ID (it moved, or the Inbox's ids were renumbered). */
export function isKeptMessage(db: DB, account: string): (messageId: string) => boolean {
  const has = db.prepare("SELECT 1 FROM inbox WHERE account = ? AND message_id = ?");
  return (mid) => !!has.get(account, mid);
}

/** The folder part of a folder id (`<UIDVALIDITY>:<UID>:<folder>`). */
const folderOf = (id: string) => /^\d+:\d+:([\s\S]+)$/.exec(id)?.[1] ?? "";

/**
 * Keep what one refresh of a mailbox found, in one transaction:
 * 1. moved: a kept message found in the Inbox under another id takes that id; one marked done is back in the Inbox
 *    (the owner moved it back in Apple Mail);
 * 2. new mail is kept;
 * 3. mail kept as in the Inbox (or snoozed there) that is no longer in it was archived, moved or deleted elsewhere:
 *    it goes. Done mail is in Archive and stays (for its kept time). Nothing goes when the listing found no Inbox.
 */
export function keepInbox(db: DB, account: string, found: { present: string[] | null; seen?: string[] | null; flagged?: string[] | null; mails: InboxMail[]; moved: { id: string; message_id: string }[]; refs?: { id: string; refs: string[] }[] }): { kept: number; gone: number; woken: string[]; fresh: string[] } {
  const insert = db.prepare(`INSERT OR IGNORE INTO inbox (account, id, key, message_id, at, from_name, from_address, reply_to, subject, text, automated, unsubscribe, list_id, html, remote, logo_domain, refs, mine, state, seen, cards, attachments, rcpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const setRefs = db.prepare("UPDATE inbox SET refs = ? WHERE account = ? AND id = ?");
  const fresh: string[] = [];
  // A brand's logo, fetched later (fetchMailImages); a new address for it is fetched again.
  const logo = db.prepare("INSERT INTO logos (domain, url) VALUES (?, ?) ON CONFLICT(domain) DO UPDATE SET url = excluded.url, svg = CASE WHEN logos.url = excluded.url THEN logos.svg END, fetched_at = CASE WHEN logos.url = excluded.url THEN logos.fetched_at END");
  const move = db.prepare("UPDATE inbox SET id = ?, state = CASE state WHEN 'done' THEN 'inbox' ELSE state END, done_at = CASE state WHEN 'done' THEN NULL ELSE done_at END WHERE account = ? AND message_id = ?");
  let kept = 0;
  let gone = 0;
  db.transaction(() => {
    // A mail carrying a kept mail's Message-ID is that mail having moved only when the kept one is no longer where it
    // was. While it is, the newcomer is another mail under the same id (anyone can write any id), and taking it for
    // the kept one would point Done and the read mark at it.
    const here = found.present ? new Set(found.present) : null;
    const idOf = db.prepare("SELECT id FROM inbox WHERE account = ? AND message_id = ?");
    for (const m of found.moved) {
      const at = (idOf.get(account, m.message_id) as { id: string } | undefined)?.id;
      if (at && at !== m.id && here?.has(at)) continue;
      move.run(m.id, account, m.message_id);
    }
    for (const m of found.mails) {
      const added = insert.run(account, m.id, mailKey(account, m.id), m.message_id, m.at.toISOString(), m.from.name, m.from.address, m.reply_to,
        m.subject, m.text, m.automated ? 1 : 0, m.unsubscribe ? 1 : 0, m.list_id, m.html, m.html && m.remote.length ? JSON.stringify(m.remote) : null, m.logo?.domain ?? null,
        JSON.stringify(m.refs ?? []), m.mine ? 1 : 0, m.mine ? "sent" : "inbox", m.mine ? 1 : 0, JSON.stringify(m.mine ? [] : m.cards ?? []), m.attachments ? JSON.stringify(m.attachments) : null, m.rcpt ? JSON.stringify(m.rcpt) : null).changes;
      if (added && !m.mine) { kept++; fresh.push(mailKey(account, m.id)); }
      if (m.logo) logo.run(m.logo.domain, m.logo.url);
    }
    for (const r of found.refs ?? []) setRefs.run(JSON.stringify(r.refs), account, r.id);
    // Read or unread as the mailbox has it now (read in Apple Mail counts; Aeneas writes its own opening there too).
    if (found.present && found.seen) {
      const read = new Set(found.seen);
      const mark = db.prepare("UPDATE inbox SET seen = ? WHERE account = ? AND id = ? AND seen != ?");
      for (const id of found.present) { const v = read.has(id) ? 1 : 0; mark.run(v, account, id, v); }
    }
    // Pinned as the mailbox has it (since 2026-11-21): a message flagged in Apple Mail is pinned here, one not flagged
    // is not; a thread is pinned while any of its mail is (Pin here flags all of it).
    if (found.present && found.flagged) {
      const pins = new Set(found.flagged);
      const pin = db.prepare("UPDATE inbox SET pinned = ? WHERE account = ? AND id = ? AND pinned != ?");
      for (const id of found.present) { const v = pins.has(id) ? 1 : 0; pin.run(v, account, id, v); }
    }
    if (found.present) {
      const here = new Set(found.present);
      const inboxFolders = new Set(found.present.map(folderOf));
      const del = db.prepare("DELETE FROM inbox WHERE account = ? AND id = ?");
      const rows = db.prepare("SELECT id FROM inbox WHERE account = ? AND state IN ('inbox', 'snoozed')").all(account) as { id: string }[];
      for (const r of rows) {
        // Only mail kept from the Inbox folder can be said to have left it (an empty Inbox names no folder: all left).
        if (here.has(r.id)) continue;
        if (inboxFolders.size && !inboxFolders.has(folderOf(r.id))) continue;
        gone += del.run(account, r.id).changes;
      }
    }
  }).immediate();
  rethread(db, account);
  // The owner's replies stay only while their thread has other mail kept.
  gone += db.prepare("DELETE FROM inbox WHERE account = ? AND state = 'sent' AND (thread IS NULL OR thread NOT IN (SELECT thread FROM inbox WHERE account = ? AND state != 'sent' AND thread IS NOT NULL))").run(account, account).changes;
  if (gone) db.pragma("wal_checkpoint(TRUNCATE)");
  // A new message in a snoozed thread brings the thread back, as a reply should.
  const woken = fresh.length ? (db.prepare(`SELECT DISTINCT s.key FROM inbox s JOIN inbox n ON n.thread = s.thread WHERE s.account = ? AND s.state = 'snoozed' AND n.key IN (${fresh.map(() => "?").join(",")})`).all(account, ...fresh) as { key: string }[]).map((r) => r.key) : [];
  return { kept, gone, woken, fresh };
}

/** A subject without its reply and forward marks, for matching a reply that carries no thread headers. */
const REPLY_MARKS = ["antw", "fwd", "fw", "re", "aw", "sv", "wg"];
/**
 * A subject without the reply and forward marks in front of it ("Re: ", "AW: ", "Fwd[2]: "), lower-cased, and how many
 * marks it had. Read left to right once: a subject is the sender's text, and a pattern for this went over a long run
 * of spaces again and again.
 */
export function subjectParts(subject: string): { bare: string; marks: number } {
  const n = subject.length;
  const space = (i: number) => { while (i < n && /\s/.test(subject[i])) i++; return i; };
  let at = 0;
  let marks = 0;
  for (;;) {
    let i = space(at);
    const head = subject.slice(i, i + 4).toLowerCase();
    const mark = REPLY_MARKS.find((m) => head.startsWith(m));
    if (!mark) break;
    i = space(i + mark.length);
    if (subject[i] === "[") {
      let k = i + 1;
      while (k < n && subject[k] >= "0" && subject[k] <= "9") k++;
      if (k === i + 1 || subject[k] !== "]") break;
      i = space(k + 1);
    }
    if (subject[i] !== ":") break;
    at = i + 1;
    marks++;
  }
  return { bare: subject.slice(at).trim().toLowerCase(), marks };
}
const THREAD_FALLBACK_MS = 30 * DAY_MS;

/**
 * Put a mailbox's kept mail into threads, all of it at once (so a reply that links two threads joins them):
 * - a message is in the thread of any kept message it names in `In-Reply-To` or `References`, or that names it;
 * - a reply with neither header ("Re: Gutters") joins the newest earlier message of the last 30 days with the same
 *   subject (marks aside) from the same person, or the owner's own;
 * - a thread's id is the first 16 hex characters of the SHA-256 of the mailbox and its first message's Message-ID.
 */
export function rethread(db: DB, account: string): void {
  type T = { key: string; message_id: string | null; refs: string | null; subject: string; from_address: string; at: string; mine: number; thread: string | null };
  const rows = db.prepare("SELECT key, message_id, refs, subject, from_address, at, mine, thread FROM inbox WHERE account = ? ORDER BY at, key").all(account) as T[];
  const parent = new Map(rows.map((r) => [r.key, r.key]));
  const find = (k: string): string => { let p = parent.get(k)!; while (p !== parent.get(p)) p = parent.get(p)!; parent.set(k, p); return p; };
  const join = (a: string, b: string) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
  // Each mail's subject is read once. Mail is whatever a sender wrote, and this runs over every kept mail after every
  // refresh: looking back through the earlier mails for each reply, with the subject taken apart again each time,
  // took a minute for a thousand crafted mails. One pass now, with the latest mail of each subject remembered.
  const parts = new Map(rows.map((r) => [r.key, subjectParts(r.subject)]));
  const byMid = new Map<string, T>();
  for (const r of rows) if (r.message_id && !byMid.has(r.message_id)) byMid.set(r.message_id, r);
  /** The latest mail so far with a subject, and the latest from each sender (never the owner's own, see below). */
  const lastAny = new Map<string, T>();
  const lastFrom = new Map<string, T>();
  for (const r of rows) {
    const mine = parts.get(r.key)!;
    let refs: string[] = [];
    try { refs = r.refs ? (JSON.parse(r.refs) as unknown[]).filter((x): x is string => typeof x === "string") : []; } catch { /* none */ }
    // By what it answers, when the subject is the same too (as mail apps thread): a mail that only names a kept
    // Message-ID under another subject does not get into that conversation.
    for (const id of refs) { const o = byMid.get(id); if (o && o !== r && parts.get(o.key)!.bare === mine.bare) join(o.key, r.key); }
    // A reply with no thread headers: the owner's own joins the latest mail of that subject; anyone else's joins only
    // the latest mail the same sender wrote under it. A stranger who knows a subject does not get into its thread
    // (that used to wake a snoozed thread and put the stranger's words in its row).
    if (!refs.length && mine.marks > 0) {
      const o = r.mine ? lastAny.get(mine.bare) : lastFrom.get(`${mine.bare}\n${r.from_address.toLowerCase()}`);
      if (o && Date.parse(r.at) - Date.parse(o.at) <= THREAD_FALLBACK_MS) join(o.key, r.key);
    }
    lastAny.set(mine.bare, r);
    if (!r.mine) lastFrom.set(`${mine.bare}\n${r.from_address.toLowerCase()}`, r);
  }
  const first = new Map<string, T>();
  for (const r of rows) if (!first.has(find(r.key))) first.set(find(r.key), r);
  const save = db.prepare("UPDATE inbox SET thread = ? WHERE key = ?");
  db.transaction(() => {
    for (const r of rows) {
      const f = first.get(find(r.key))!;
      const thread = crypto.createHash("sha256").update(`${account}\n${f.message_id ?? f.key}`).digest("hex").slice(0, 16);
      if (r.thread !== thread) save.run(thread, r.key);
    }
  }).immediate();
}

/** Unlinking a mailbox: its mail goes at once. */
export function deleteMailbox(db: DB, account: string): number {
  const n = db.prepare("DELETE FROM inbox WHERE account = ?").run(account).changes + db.prepare("DELETE FROM folder_mail WHERE account = ?").run(account).changes;
  db.prepare("DELETE FROM folders WHERE account = ?").run(account);
  db.prepare("DELETE FROM mailboxes WHERE account = ?").run(account);
  db.pragma("wal_checkpoint(TRUNCATE)");
  return n;
}

/** The module switched off: every message goes. */
export function deleteAllMail(db: DB): number {
  const n = db.prepare("DELETE FROM inbox").run().changes + db.prepare("DELETE FROM folder_mail").run().changes;
  db.prepare("DELETE FROM folders").run();
  db.prepare("DELETE FROM mailboxes").run();
  db.prepare("DELETE FROM logos").run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what is kept (the routes)

/** `sent`: the owner's own reply in a thread (from the Sent folder), never in a list of its own. `folder`: in another folder (folder_mail). */
export type MailState = "inbox" | "snoozed" | "done" | "sent" | "folder";
/** One message in the list: no text, a first line of it. */
export interface MailSummary {
  id: string; at: string; from: MailAddress; reply_to?: string; subject: string; preview: string;
  automated: boolean; bundle: string | null; state: MailState; pinned: boolean; snooze_until?: string;
  /** The sender's verified brand logo, by domain: the list's `logos` has the picture. */
  logo_domain?: string;
  /** When it came back from a snooze: the Inbox lists it by this time, not by when it arrived. */
  back_at?: string;
  /** Read: opened on the Mail screen, or read in another mail app (the mailbox's own flag). */
  seen: boolean;
  /** Its thread (rethread): the screen shows a thread as one row. */
  thread?: string;
  /** The owner's own reply (state `sent`). */
  mine?: boolean;
  /** The local model's triage (mail-triage.ts): how soon it matters, what it is, whether it needs a reply; kept 7 days. */
  triage?: Triage;
  /** How many attachments it has (the row's paperclip), absent when none, null when not known yet (kept before 2026-11-21: clients ask once, on opening it). */
  attachments?: number | null;
  /** Its key facts (mail-cards.ts): a package, a flight, a bill; absent when it has none. */
  cards?: MailCard[];
}
/**
 * One message whole: its text, and its HTML as a page to show (mailDocument: cleaned, nothing in it loads anything),
 * or null when it has none. `pictures_pending`: its web pictures are still being fetched. `pictures_ask`: this hub has
 * no Tor, so they are fetched only when the person asks for this mail's (POST /mail/messages/:id/pictures).
 */
export interface MailMessage extends MailSummary {
  text: string; html: string | null; pictures_pending: boolean; pictures_ask: boolean;
  /** Where the quoted history starts in `text` (quoteStart), which clients fold; absent when it has none. */
  quote_at?: number;
  /** The owner said not to fold this mail (a folding note): clients show its page unfolded too. */
  no_fold?: boolean;
}

type Row = { key: string; at: string; from_name: string; from_address: string; reply_to: string | null; subject: string; text: string; automated: number; bundle: string | null; state: MailState; pinned: number; snooze_until: string | null; logo_domain?: string | null; back_at?: string | null; seen?: number; thread?: string | null; mine?: number; cards?: string | null; attachments?: string | null; triage?: string | null; fold_note?: string | null };

/**
 * A message's cards: those stored at refresh (from the sender's data, or its text); for mail kept before cards (NULL),
 * what its text shows, worked out now. Only for mail a system sent: a person's "my confirmation number is" is theirs.
 */
function cardsOf(r: Row): MailCard[] {
  if (r.mine) return [];
  if (r.cards != null) { try { return JSON.parse(r.cards) as MailCard[]; } catch { return []; } }
  return r.automated ? textCards(r.subject, r.text, { name: r.from_name, address: r.from_address }) : [];
}

/**
 * The first words of a message for the list: its own words (ownWords: not the quoted history a reply carries) on one
 * line, at most 200 characters, links by their words only (`label (https://…)`, `[label](https://…)` and bare
 * addresses lose the address). Only the start of the text is read for it (PREVIEW_READ): a mail of nothing but
 * `(http://(http://…` cannot make it take long.
 */
const PREVIEW_READ = 4000;
export const previewOf = (text: string) => withoutSignature(ownWords(text.slice(0, PREVIEW_READ)))
  .replace(/\[([^\]\n]{0,300})\]\(\s*(https?:|mailto:)[^)\s]*\s*\)/gi, "$1")
  .replace(/\s*[(<]\s*(https?:\/\/|mailto:)[^)>\s]*\s*[)>]/gi, "")
  .replace(/(https?:\/\/|www\.)[^\s)]+/gi, "")
  .replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim().slice(0, 200);

/** The kept recipients (To and Cc), or undefined for mail kept before they were. */
const rcptOf = (s: string | null | undefined): string[] | undefined => { try { return s ? (JSON.parse(s) as string[]) : undefined; } catch { return undefined; } };

/** A kept triage, or null (none, or one the hub cannot read). */
const triageOf = (s: string | null | undefined): Triage | null => { try { return s ? readTriage(s) : null; } catch { return null; } };

/** A kept folding note: the line the fold started at, the lines the owner said matter, and whether not to fold the mail. */
export interface FoldNote { cut: string; lines: string[]; no_fold: boolean; at: string }
const foldNoteOf = (s: string | null | undefined): FoldNote | null => { try { return s ? (JSON.parse(s) as FoldNote) : null; } catch { return null; } };
const noFold = (s: string | null | undefined) => !!foldNoteOf(s)?.no_fold;

/** How many attachments a kept list holds (0 when none or not known). */
const attachmentCount = (s: string | null | undefined): number => { try { return s ? (JSON.parse(s) as unknown[]).length : 0; } catch { return 0; } };

function summary(r: Row): MailSummary {
  const s: MailSummary = {
    id: r.key, at: r.at, from: { name: r.from_name, address: r.from_address },
    ...(r.reply_to ? { reply_to: r.reply_to } : {}),
    subject: r.subject, preview: noFold(r.fold_note) ? withoutSignature(r.text.slice(0, PREVIEW_READ)).replace(/\s+/g, " ").trim().slice(0, 200) : previewOf(r.text), automated: !!r.automated, bundle: r.bundle, state: r.state, pinned: !!r.pinned,
    ...(r.snooze_until ? { snooze_until: r.snooze_until } : {}),
    ...(r.logo_domain ? { logo_domain: r.logo_domain } : {}),
    ...(r.back_at ? { back_at: r.back_at } : {}),
    seen: !!r.seen,
    ...(r.thread ? { thread: r.thread } : {}),
    ...(r.mine ? { mine: true } : {}),
    ...(r.attachments == null ? { attachments: null } : attachmentCount(r.attachments) ? { attachments: attachmentCount(r.attachments) } : {}),
    ...(triageOf(r.triage) ? { triage: triageOf(r.triage)! } : {}),
  };
  const cards = cardsOf(r);
  return cards.length ? { ...s, cards } : s;
}

/** At most this many messages in one list answer, newest first. */
export const LIST_MAX = 5000;

/**
 * Everything kept, newest first, each in its bundle (mail-bundles.ts, worked out now from `ctx`, the owner's records):
 * the screen sorts it into Inbox, Snoozed, Done and the bundles.
 */
export function listMail(db: DB, ctx: BundleContext = NO_MODULES): MailSummary[] {
  const rows = db.prepare("SELECT key, at, from_name, from_address, reply_to, subject, substr(text, 1, 3000) AS text, automated, unsubscribe, list_id, rcpt, bundle, state, pinned, snooze_until, logo_domain, back_at, seen, thread, mine, cards, attachments, triage, fold_note FROM inbox ORDER BY coalesce(back_at, at) DESC, key LIMIT ?").all(LIST_MAX) as (Row & { unsubscribe: number; list_id: string | null; rcpt: string | null })[];
  return rows.map((r) => ({
    ...summary(r),
    bundle: bundleOf({ from: { name: r.from_name, address: r.from_address }, subject: r.subject, automated: !!r.automated, unsubscribe: !!r.unsubscribe, list_id: r.list_id, text: r.text, to: rcptOf(r.rcpt) }, ctx),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// One thing at a time per hub: a refresh and a Done never overlap, or a listing made before a move could put the mail
// back in the Inbox after it.

const locks = new WeakMap<Hub, Promise<unknown>>();
function exclusive<T>(hub: Hub, job: () => Promise<T>): Promise<T> {
  const run = (locks.get(hub) ?? Promise.resolve()).catch(() => {}).then(job);
  locks.set(hub, run.catch(() => {}));
  return run;
}

// ---------------------------------------------------------------------------------------------------------------------
// Done and Undo: the Mail screen's only change to the mailbox (its source's move: iCloud's moveICloud, Inbox to Archive and back)

/** How long Done mail stays on the hub (the Done view, Undo); in iCloud it stays in Archive. */
export const DONE_DAYS = 30;
/** At most this many mails in one Done or Undo (a Sweep of a big day). */
export const MOVE_MAX = 500;
export interface MoveResult { moved: string[]; failed: number; error?: string }

/** Done: kept mail in the Inbox (or snoozed) moves to iCloud's Archive and shows under Done. */
export async function markDone(hub: Hub, keys: string[], now = new Date()): Promise<MoveResult> {
  const r = await moveKept(hub, keys, "archive", now);
  finishSnoozeTasks(hub, r.moved, now);
  return r;
}
/** Undo (or "Move to Inbox" from Done): done mail moves back from Archive to the Inbox. */
export const undoDone = (hub: Hub, keys: string[]) => moveKept(hub, keys, "inbox");

async function moveKept(hub: Hub, keys: string[], to: "archive" | "inbox", now = new Date()): Promise<MoveResult> {
  return exclusive(hub, async () => {
    const db = hub.mailDb;
    const get = db.prepare("SELECT key, account, id, message_id, state FROM inbox WHERE key = ?");
    const from = to === "archive" ? ["inbox", "snoozed"] : ["done"];
    /** For the log: which of the two this is (never anything of the mail). */
    const step = to === "archive" ? "done" : "undo";
    const rows = [...new Set(keys)].slice(0, MOVE_MAX).map((k) => get.get(k) as { key: string; account: string; id: string; message_id: string | null; state: MailState } | undefined)
      .filter((r): r is NonNullable<typeof r> => !!r && from.includes(r.state));
    let failed = Math.min(keys.length, MOVE_MAX) - rows.length;
    const moved: string[] = [];
    let error: string | undefined;
    const save = to === "archive"
      ? db.prepare("UPDATE inbox SET id = ?, state = 'done', done_at = ?, snooze_until = NULL WHERE key = ?")
      : db.prepare("UPDATE inbox SET id = ?, state = 'inbox', done_at = NULL WHERE key = ?");
    for (const account of new Set(rows.map((r) => r.account))) {
      const mine = rows.filter((r) => r.account === account);
      try {
        const source = sourceOf(account);
        if (!source) throw new StoreError(409, "This mailbox is no longer linked.");
        const ids = await source.move(hub, account, mine.map((r) => ({ id: r.id, message_id: r.message_id })), to);
        db.transaction(() => {
          for (const r of mine) {
            const id = ids.get(r.id);
            if (!id) { failed++; continue; }
            if (to === "archive") save.run(id, now.toISOString(), r.key); else save.run(id, r.key);
            moved.push(r.key);
          }
        }).immediate();
      } catch (e) {
        failed += mine.length;
        error = e instanceof StoreError ? e.message : "The mail could not be moved. The hub's log has the error code.";
        console.error(`[mail-inbox] ${mailboxLabel(hub, account)}: ${step} ${errCode(e)}`);
      }
    }
    if (moved.length) console.log(`[mail-inbox] ${step}: ${moved.length} moved${failed ? `, ${failed} not moved` : ""}`);
    if (failed && !error) error = failed === 1 ? "One mail was not moved: it changed in iCloud since the last refresh. Refresh and try again." : `${failed} mails were not moved: they changed in iCloud since the last refresh. Refresh and try again.`;
    return { moved, failed, ...(error ? { error } : {}) };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Snooze: on the hub only (the mail stays in iCloud's Inbox), with a task that says only that a mail is snoozed

/**
 * What the snooze choices mean (the owner's own, since 2026-11-20): "Later today" is `later_hours` on, on the hour;
 * "Tomorrow" at `tomorrow`; "This weekend" on `weekend_day` (0 Sunday to 6 Saturday) at `weekend_time`; "Next week" on
 * `week_day` at `week_time`. Times are `HH:MM`, on the device's clock.
 */
export interface SnoozeTimes { later_hours: number; tomorrow: string; weekend_day: number; weekend_time: string; week_day: number; week_time: string }
export const SNOOZE_DEFAULTS: SnoozeTimes = { later_hours: 3, tomorrow: "08:00", weekend_day: 6, weekend_time: "09:00", week_day: 1, week_time: "08:00" };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The owner's snooze times, the defaults for any not set. */
export function snoozeTimes(db: DB): SnoozeTimes {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'snooze_times'").get() as { value: string } | undefined;
  let saved: Partial<SnoozeTimes> = {};
  try { saved = r ? JSON.parse(r.value) as Partial<SnoozeTimes> : {}; } catch { /* defaults */ }
  return { ...SNOOZE_DEFAULTS, ...saved };
}

/** Save snooze times (only the fields given; each checked), and answer all of them. */
export function saveSnoozeTimes(db: DB, body: Record<string, unknown>): SnoozeTimes {
  const t = snoozeTimes(db);
  const day = (v: unknown, name: string) => { if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 6) throw new StoreError(422, `${name} is a day from 0 (Sunday) to 6 (Saturday)`); return v as number; };
  const time = (v: unknown, name: string) => { if (typeof v !== "string" || !HHMM.test(v)) throw new StoreError(422, `${name} is a time like 08:00`); return v; };
  if (body.later_hours !== undefined) {
    if (!Number.isInteger(body.later_hours) || (body.later_hours as number) < 1 || (body.later_hours as number) > 12) throw new StoreError(422, "later_hours is a whole number of hours from 1 to 12");
    t.later_hours = body.later_hours as number;
  }
  if (body.tomorrow !== undefined) t.tomorrow = time(body.tomorrow, "tomorrow");
  if (body.weekend_day !== undefined) t.weekend_day = day(body.weekend_day, "weekend_day");
  if (body.weekend_time !== undefined) t.weekend_time = time(body.weekend_time, "weekend_time");
  if (body.week_day !== undefined) t.week_day = day(body.week_day, "week_day");
  if (body.week_time !== undefined) t.week_time = time(body.week_time, "week_time");
  db.prepare("INSERT INTO settings (key, value) VALUES ('snooze_times', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(t));
  return t;
}

/**
 * When a bundle's mail shows in the Inbox (since 2026-11-20): `now` as it arrives (no setting is the same), `daily` at
 * `time`, `weekly` on `day` (0 Sunday to 6 Saturday) at `time`, or `never` (only in the bundle's own view). Clients work
 * out from each mail's arrival when it shows; pinned mail always does. Nothing changes in the mailbox.
 */
export interface BundleDelivery { mode: "now" | "daily" | "weekly" | "never"; time?: string; day?: number }

/** Each bundle's delivery, for those set. */
export function bundleDelivery(db: DB): Record<string, BundleDelivery> {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'bundle_delivery'").get() as { value: string } | undefined;
  try { return r ? JSON.parse(r.value) as Record<string, BundleDelivery> : {}; } catch { return {}; }
}

/** Set one bundle's delivery (checked), and answer them all. */
export function saveBundleDelivery(db: DB, bundleAsSent: string, body: Record<string, unknown>): Record<string, BundleDelivery> {
  const bundle = currentBundleId(bundleAsSent);
  if (!(BUNDLE_IDS as readonly string[]).includes(bundle) && !customBundles(db).some((b) => b.id === bundle)) throw new StoreError(404, "there is no such bundle");
  const mode = body.mode;
  if (mode !== "now" && mode !== "daily" && mode !== "weekly" && mode !== "never") throw new StoreError(422, "mode is now, daily, weekly or never");
  const d: BundleDelivery = { mode };
  if (mode === "daily" || mode === "weekly") {
    if (typeof body.time !== "string" || !HHMM.test(body.time)) throw new StoreError(422, "time is a time like 07:00");
    d.time = body.time;
  }
  if (mode === "weekly") {
    if (!Number.isInteger(body.day) || (body.day as number) < 0 || (body.day as number) > 6) throw new StoreError(422, "day is a day from 0 (Sunday) to 6 (Saturday)");
    d.day = body.day as number;
  }
  const all = bundleDelivery(db);
  if (mode === "now") delete all[bundle]; else all[bundle] = d;
  db.prepare("INSERT INTO settings (key, value) VALUES ('bundle_delivery', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(all));
  return all;
}

/**
 * New-mail notifications (since 2026-11-20): which new mail notifies, and what a notification says. `people`: mail
 * from a person (in no bundle); `bundles`: those whose mail notifies too, while it shows as it arrives; `detail`:
 * `full` (sender and subject), `sender`, or `count`.
 */
export interface MailNotify { people: boolean; bundles: string[]; detail: "full" | "sender" | "count" }
export const NOTIFY_DEFAULTS: MailNotify = { people: true, bundles: [], detail: "full" };
/** Mail this much older than the last refresh still counts as new (a clock a little off). */
const NOTIFY_SLACK_MS = 10 * 60_000;

export function mailNotify(db: DB): MailNotify {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'mail_notify'").get() as { value: string } | undefined;
  try { return { ...NOTIFY_DEFAULTS, ...(r ? JSON.parse(r.value) as Partial<MailNotify> : {}) }; } catch { return { ...NOTIFY_DEFAULTS }; }
}

/** Change the notification settings: `people`, `detail`, or one bundle (`bundle` with `on`). */
export function saveMailNotify(db: DB, body: Record<string, unknown>): MailNotify {
  const n = mailNotify(db);
  if (body.people !== undefined) { if (typeof body.people !== "boolean") throw new StoreError(422, "people is true or false"); n.people = body.people; }
  if (body.detail !== undefined) { if (body.detail !== "full" && body.detail !== "sender" && body.detail !== "count") throw new StoreError(422, "detail is full, sender or count"); n.detail = body.detail; }
  if (body.bundle !== undefined) {
    if (typeof body.bundle !== "string" || typeof body.on !== "boolean") throw new StoreError(422, "bundle is a bundle's id, with on true or false");
    body.bundle = currentBundleId(body.bundle);
    if (!(BUNDLE_IDS as readonly string[]).includes(body.bundle) && !customBundles(db).some((b) => b.id === body.bundle)) throw new StoreError(404, "there is no such bundle");
    n.bundles = body.on ? [...new Set([...n.bundles, body.bundle])] : n.bundles.filter((b) => b !== body.bundle);
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('mail_notify', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(n));
  return n;
}

/**
 * One notification for the new mail of a refresh that the owner wants to hear about: from a person, or in a bundle
 * they switched on that shows as it arrives (held mail shows later, quietly). Sent to connected devices only (the
 * `notify` event); the log has the count only.
 */
export function notifyNewMail(hub: Hub, keys: string[], now = new Date()): number {
  if (!keys.length) return 0;
  const db = hub.mailDb;
  const settings = mailNotify(db);
  const delivery = bundleDelivery(db);
  const ctx = bundleContext(hub);
  const get = db.prepare("SELECT from_name, from_address, subject, substr(text, 1, 3000) AS text, automated, unsubscribe, list_id, rcpt, state, seen FROM inbox WHERE key = ?");
  const hits: { name: string; subject: string }[] = [];
  for (const key of keys) {
    const r = get.get(key) as { from_name: string; from_address: string; subject: string; text: string; automated: number; unsubscribe: number; list_id: string | null; rcpt: string | null; state: string; seen: number } | undefined;
    // Mail already read in another mail app is not news.
    if (!r || r.state !== "inbox" || r.seen) continue;
    const bundle = bundleOf({ from: { name: r.from_name, address: r.from_address }, subject: r.subject, automated: !!r.automated, unsubscribe: !!r.unsubscribe, list_id: r.list_id, text: r.text, to: rcptOf(r.rcpt) }, ctx);
    const wanted = bundle === null ? settings.people : settings.bundles.includes(bundle) && (delivery[bundle]?.mode ?? "now") === "now";
    if (wanted) hits.push({ name: oneLine(r.from_name) || oneLine(r.from_address), subject: oneLine(r.subject, 120) });
  }
  if (!hits.length) return 0;
  hub.bus.emit("notify", { id: `mail:${now.toISOString()}`, kind: "mail", title: notifyTitle(hits, settings.detail), at: now.toISOString() });
  console.log(`[mail-inbox] notified of ${hits.length} new mail(s)`);
  return hits.length;
}

/** A notification's words for some new mail, as `detail` says: who and what, who only, or a count. */
/**
 * A sender's name or a subject as an alert shows it: one line, no control characters or characters that turn the
 * text around, and short. A name is the sender's own text, and with a line break in it an alert read as two lines
 * of the hub's own ("The hub's disk is almost full", then a made-up sender).
 */
const oneLine = (s: string, max = 60) => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function notifyTitle(hits: { name: string; subject: string }[], detail: MailNotify["detail"], lead = ""): string {
  const names = [...new Set(hits.map((h) => h.name))];
  const who = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
  const count = hits.length === 1 ? "1 new mail" : `${hits.length} new mails`;
  if (detail === "count") return `${lead}${count}`;
  if (detail === "sender") return hits.length === 1 ? `${lead}New mail from ${who}` : `${lead}${count} from ${who}`;
  return hits.length === 1 ? `${lead}${hits[0].name}: ${hits[0].subject || "(no subject)"}` : `${lead}${count}: ${who}`;
}

/** The latest time a held bundle showed (`daily` or `weekly`) at or before `now`, on the hub's clock. */
export function lastDelivery(d: BundleDelivery, now: Date): Date | null {
  if (d.mode !== "daily" && d.mode !== "weekly") return null;
  const [h, m] = (d.time ?? "00:00").split(":").map(Number);
  const t = new Date(now);
  t.setHours(h || 0, m || 0, 0, 0);
  if (d.mode === "weekly") t.setDate(t.getDate() - ((t.getDay() - (d.day ?? 0) + 7) % 7));
  if (t > now) t.setDate(t.getDate() - (d.mode === "daily" ? 1 : 7));
  return t;
}

/**
 * Held bundles (once a day, once a week) whose time has come since the last look, and that the owner switched on:
 * one notification each for the mail they bring to the Inbox ("Promos: 5 new mails: …"). Run every minute.
 */
export function notifyDeliveries(hub: Hub, now = new Date()): number {
  const db = hub.mailDb;
  const last = (db.prepare("SELECT value FROM settings WHERE key = 'delivery_checked'").get() as { value: string } | undefined)?.value;
  db.prepare("INSERT INTO settings (key, value) VALUES ('delivery_checked', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now.toISOString());
  if (!last) return 0;
  const settings = mailNotify(db);
  const delivery = bundleDelivery(db);
  const due = settings.bundles.map((b) => ({ b, d: delivery[b], at: delivery[b] ? lastDelivery(delivery[b], now) : null }))
    .filter((x): x is { b: string; d: BundleDelivery; at: Date } => !!x.at && x.at.toISOString() > last);
  if (!due.length) return 0;
  const ctx = bundleContext(hub);
  const custom = new Map(customBundles(db).map((c) => [c.id, c.name]));
  const rows = db.prepare("SELECT from_name, from_address, subject, substr(text, 1, 3000) AS text, automated, unsubscribe, list_id, rcpt, at, pinned FROM inbox WHERE state = 'inbox' AND mine = 0 AND at >= ?")
    .all(new Date(now.getTime() - 8 * DAY_MS).toISOString()) as { from_name: string; from_address: string; subject: string; text: string; automated: number; unsubscribe: number; list_id: string | null; rcpt: string | null; at: string; pinned: number }[];
  let sent = 0;
  for (const { b, d, at } of due) {
    const from = new Date(at);
    from.setDate(from.getDate() - (d.mode === "daily" ? 1 : 7));
    const hits = rows.filter((r) => !r.pinned && r.at >= from.toISOString() && r.at < at.toISOString()
      && bundleOf({ from: { name: r.from_name, address: r.from_address }, subject: r.subject, automated: !!r.automated, unsubscribe: !!r.unsubscribe, list_id: r.list_id, text: r.text, to: rcptOf(r.rcpt) }, ctx) === b)
      .map((r) => ({ name: (r.from_name.trim() || r.from_address).slice(0, 60), subject: r.subject.replace(/\s+/g, " ").trim().slice(0, 120) }));
    if (!hits.length) continue;
    hub.bus.emit("notify", { id: `mail:${b}:${at.toISOString()}`, kind: "mail", title: notifyTitle(hits, settings.detail, `${BUNDLE_NAMES[b] ?? custom.get(b) ?? "Mail"}: `), at: now.toISOString() });
    sent++;
  }
  if (sent) console.log(`[mail-inbox] notified of ${sent} bundle(s) arriving`);
  return sent;
}

/** A message's whole thread (two parameters: the key, twice): what Pin and Snooze act on. */
const THREAD_OF = "key = ? OR (thread IS NOT NULL AND thread = (SELECT thread FROM inbox WHERE key = ?))";
/** A snooze ends at most this far ahead. */
export const SNOOZE_MAX_DAYS = 366;
type SnoozeRow = { key: string; state: MailState; task_id: string | null };
const openTask = (hub: Hub, id: string | null) => {
  const t = id ? hub.store.get(id) : null;
  return t && !t.deleted_at && t.fields.status !== "done" ? t : null;
};

/** What a snooze's task is called: never the mail's own words. */
export const SNOOZE_TASK_TITLE = "Snoozed mail";

/**
 * Snooze a mail in the Inbox (or snooze it again) until `until`: it leaves the Inbox for Snoozed, and a task reminds
 * at that time, in Tasks and Reminders. The task is titled "Snoozed mail" and points at the mail by its id
 * (`task.mail`); it holds none of the mail's words. Tasks sync to every device, are in backups and are open to the
 * assistant, and a subject is written by whoever sent the mail: with it in a task, mail would reach the model after
 * all, and a crafted subject could try to steer it. The Mail screen's Snoozed list says which mail it is. False when
 * the mail is not kept or is done.
 */
export function snoozeMail(hub: Hub, key: string, until: Date): boolean {
  const db = hub.mailDb;
  const r = db.prepare("SELECT key, state, task_id FROM inbox WHERE key = ?").get(key) as SnoozeRow | undefined;
  if (!r || r.state === "done") return false;
  const when = until.toISOString();
  // The thread's open task, whichever of its messages carries it: a thread that came back, got a reply and is
  // snoozed again keeps its one task (the reply has none of its own, and a second task was made for it).
  const carried = r.task_id ?? (db.prepare(`SELECT task_id FROM inbox WHERE task_id IS NOT NULL AND (${THREAD_OF}) LIMIT 1`).get(key, key) as { task_id: string } | undefined)?.task_id ?? null;
  let task = openTask(hub, carried);
  if (task) task = hub.store.patch(task.id, { remind_at: when, snoozed_until: null });
  else task = hub.store.create("task", { title: SNOOZE_TASK_TITLE, status: "scheduled", order: Date.now(), remind_at: when, mail: key });
  // The whole thread: every message of it in the Inbox (its done mail and the owner's replies stay as they are).
  db.prepare(`UPDATE inbox SET state = 'snoozed', snooze_until = ?, task_id = ?, back_at = NULL WHERE state IN ('inbox', 'snoozed') AND (${THREAD_OF})`).run(when, task.id, key, key);
  return true;
}

/**
 * Back to the Inbox now (Unsnooze, or its task was done or deleted), at the top. `keepTask`: leave the task as it is
 * (it is what brought the mail back); otherwise an open one is deleted, as the snooze it stood for is over.
 */
export function unsnoozeMail(hub: Hub, key: string, opts: { keepTask?: boolean } = {}, now = new Date()): boolean {
  const db = hub.mailDb;
  const r = db.prepare("SELECT key, state, task_id FROM inbox WHERE key = ?").get(key) as SnoozeRow | undefined;
  if (!r || r.state !== "snoozed") return false;
  db.prepare(`UPDATE inbox SET state = 'inbox', snooze_until = NULL, task_id = NULL, back_at = ? WHERE state = 'snoozed' AND (${THREAD_OF})`).run(now.toISOString(), key, key);
  const task = opts.keepTask ? null : openTask(hub, r.task_id);
  if (task) hub.store.patch(task.id, { deleted_at: now.toISOString() });
  return true;
}

/**
 * Snoozes whose time has come: back to the Inbox, at the top. Their task stays (it is the reminder that just went
 * off); done with the mail, it is done with the task too (finishSnoozeTasks).
 */
export function wakeSnoozed(hub: Hub, now = new Date()): number {
  return hub.mailDb.prepare("UPDATE inbox SET state = 'inbox', back_at = snooze_until, snooze_until = NULL WHERE state = 'snoozed' AND snooze_until <= ?").run(now.toISOString()).changes;
}

/** Mail marked done: its snooze's task, if still open, is done too. */
/** What Delete, Spam, Not spam and Move to did: the mail moved, and for each one now kept in a folder its new id (Undo takes it). */
export interface MoveToResult extends MoveResult { to: Record<string, string> }

/**
 * Delete (`trash`), Spam (`junk`), Not spam and Move to Inbox (`inbox`), or Move to one of the owner's folders (its key):
 * kept mail, from the Inbox (and Snoozed and Done) or a kept folder, moves there in iCloud (the source's moveTo: MOVE
 * only, each message checked again), after any refresh or move that is running. On the hub, mail moved into a kept
 * folder is kept there at once under its new id; mail moved to the Inbox comes in with the refresh that follows. A
 * snoozed mail's task is done with it. Nothing is ever deleted from the mailbox: emptying Trash is the mail app's.
 */
export async function moveMail(hub: Hub, keys: string[], to: string, now = new Date()): Promise<MoveToResult> {
  const db = hub.mailDb;
  const dest = to === "inbox" || to === "trash" || to === "junk" ? null : (db.prepare("SELECT account, path FROM folders WHERE key = ? AND role = 'own'").get(to) as { account: string; path: string } | undefined);
  if (to !== "inbox" && to !== "trash" && to !== "junk" && !dest) throw new StoreError(422, "to is inbox, trash, junk or one of your own folders");
  const result = await exclusive(hub, () => moveNow(hub, keys, to, dest ?? null, now));
  // Mail moved to the Inbox comes in with a refresh (its bundle, thread and pictures as any new mail's).
  if (to === "inbox" && result.moved.length) void refreshMail(hub).catch((e) => console.error(`[mail-inbox] ${errCode(e)}`));
  return result;
}

/** moveMail's work, for a caller that already holds the hub's one-at-a-time turn (a refresh moving blocked mail). */
async function moveNow(hub: Hub, keys: string[], to: string, dest: { account: string; path: string } | null, now: Date): Promise<MoveToResult> {
  const db = hub.mailDb;
  {
    type Kept ={ key: string; account: string; id: string; message_id: string | null; table: "inbox" | "folder_mail"; state?: MailState; folder?: string };
    const inInbox = db.prepare("SELECT key, account, id, message_id, state FROM inbox WHERE key = ? AND state != 'sent'");
    const inFolder = db.prepare("SELECT key, account, id, message_id, folder FROM folder_mail WHERE key = ?");
    const rows: Kept[] = [];
    for (const k of [...new Set(keys)].slice(0, MOVE_MAX)) {
      const a = inInbox.get(k) as Kept | undefined;
      const b = a ? undefined : (inFolder.get(k) as Kept | undefined);
      if (a) rows.push({ ...a, table: "inbox" }); else if (b) rows.push({ ...b, table: "folder_mail" });
    }
    // Already where it is going: Inbox mail to the Inbox (Done's Undo does that), a folder's mail to its own folder.
    const going = rows.filter((r) => !(r.table === "inbox" && to === "inbox") && !(dest && r.folder === dest.path) && (!dest || r.account === dest.account));
    let failed = Math.min(keys.length, MOVE_MAX) - going.length;
    const moved: string[] = [];
    const newKeys: Record<string, string> = {};
    let error: string | undefined;
    for (const account of new Set(going.map((r) => r.account))) {
      const mine = going.filter((r) => r.account === account);
      try {
        const source = sourceOf(account);
        if (!source?.moveTo) throw new StoreError(409, "This mailbox is no longer linked.");
        const target = dest ? { path: dest.path } : { role: to as "inbox" | "trash" | "junk" };
        const ids = await source.moveTo(hub, account, mine.map((r) => ({ id: r.id, message_id: r.message_id })), target);
        // The kept folder it lands in, if the hub keeps it: Trash, Junk, or the owner's folder.
        const into = dest ? dest.path : to === "inbox" ? null : (db.prepare("SELECT path FROM folders WHERE account = ? AND role = ?").get(account, to) as { path: string } | undefined)?.path ?? null;
        finishSnoozeTasks(hub, mine.filter((r) => r.table === "inbox" && ids.get(r.id)).map((r) => r.key), now);
        db.transaction(() => {
          const copyInbox = db.prepare(`INSERT OR IGNORE INTO folder_mail (account, id, key, folder, message_id, at, from_name, from_address, to_list, reply_to, subject, text, automated, html, seen, attachments)
            SELECT account, ?, ?, ?, message_id, at, from_name, from_address, '[]', reply_to, subject, text, automated, html, seen, attachments FROM inbox WHERE key = ?`);
          const copyFolder = db.prepare(`INSERT OR IGNORE INTO folder_mail (account, id, key, folder, message_id, at, from_name, from_address, to_list, reply_to, subject, text, automated, html, seen, attachments)
            SELECT account, ?, ?, ?, message_id, at, from_name, from_address, to_list, reply_to, subject, text, automated, html, seen, attachments FROM folder_mail WHERE key = ?`);
          for (const r of mine) {
            const id = ids.get(r.id);
            if (!id) { failed++; continue; }
            // A real new id (iCloud has UIDPLUS): kept in its folder now; otherwise the next refresh finds it there.
            if (into && !id.startsWith("moved:")) {
              const key = mailKey(account, id);
              (r.table === "inbox" ? copyInbox : copyFolder).run(id, key, into, r.key);
              newKeys[r.key] = key;
            }
            db.prepare(`DELETE FROM ${r.table} WHERE key = ?`).run(r.key);
            moved.push(r.key);
          }
        }).immediate();
      } catch (e) {
        failed += mine.length;
        error = e instanceof StoreError ? e.message : "The mail could not be moved. The hub's log has the error code.";
        console.error(`[mail-inbox] ${mailboxLabel(hub, account)}: move ${errCode(e)}`);
      }
    }
    if (moved.length) { db.pragma("wal_checkpoint(TRUNCATE)"); console.log(`[mail-inbox] move: ${moved.length} moved${failed ? `, ${failed} not moved` : ""}`); }
    if (failed && !error) error = failed === 1 ? "One mail was not moved: it changed in iCloud since the last refresh. Refresh and try again." : `${failed} mails were not moved: they changed in iCloud since the last refresh. Refresh and try again.`;
    return { moved, failed, to: newKeys, ...(error ? { error } : {}) };
  }
}

function finishSnoozeTasks(hub: Hub, keys: string[], now: Date) {
  const db = hub.mailDb;
  const get = db.prepare("SELECT task_id FROM inbox WHERE key = ? AND task_id IS NOT NULL");
  const clear = db.prepare("UPDATE inbox SET task_id = NULL WHERE key = ?");
  for (const key of keys) {
    const r = get.get(key) as { task_id: string } | undefined;
    if (!r) continue;
    const task = openTask(hub, r.task_id);
    if (task) hub.store.patch(task.id, { status: "done", done_at: now.toISOString() });
    clear.run(key);
  }
}

/** A snooze's task marked done or deleted (in Tasks, Reminders, on any device): its mail comes back at once. */
export function installMailHooks(hub: Hub): void {
  hub.store.afterWrite((entity) => {
    if (entity.kind !== "task" || typeof entity.fields.mail !== "string") return;
    if (!entity.deleted_at && entity.fields.status !== "done") return;
    const r = hub.mailDb.prepare("SELECT key FROM inbox WHERE key = ? AND state = 'snoozed' AND task_id = ?").get(entity.fields.mail, entity.id);
    if (r) unsnoozeMail(hub, entity.fields.mail, { keepTask: true });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// What the owner does to a mail (on the hub only, nothing in iCloud changes)

/**
 * Read or unread: on the hub at once, then in the mailbox (its source's setSeen, after the refresh or move that may be
 * running). `synced`: the mailbox has it too; when not (offline, the message changed), the next refresh shows the
 * mailbox's own state again.
 */
/** At most this many messages are marked read or unread in one request. */
export const SEEN_MAX = 500;

/**
 * Mark kept messages read or unread: on the hub at once, then in the mailbox, one sign-in for each mailbox whatever
 * their number (a thread's unread mails, a selection). `ok`: how many are kept; `synced`: how many the mailbox took.
 */
export async function setSeenMany(hub: Hub, keys: string[], seen: boolean): Promise<{ ok: number; synced: number }> {
  const db = hub.mailDb;
  const get = db.prepare("SELECT key, account FROM inbox WHERE key = ?");
  const rows = [...new Set(keys)].map((k) => get.get(k) as { key: string; account: string } | undefined).filter((r): r is { key: string; account: string } => !!r);
  const mark = db.prepare("UPDATE inbox SET seen = ? WHERE key = ?");
  for (const r of rows) mark.run(seen ? 1 : 0, r.key);
  let synced = 0;
  for (const account of [...new Set(rows.map((r) => r.account))]) {
    const mine = rows.filter((r) => r.account === account);
    await exclusive(hub, async () => {
      // Each one's id where it is now: a refresh or a move may have changed it while this waited.
      const now = db.prepare("SELECT id, message_id FROM inbox WHERE key = ?");
      const refs = mine.map((r) => now.get(r.key) as { id: string; message_id: string | null } | undefined);
      const source = sourceOf(account);
      const here = refs.filter((x): x is { id: string; message_id: string | null } => !!x);
      if (!source || !here.length) return;
      synced += (await source.setSeen(hub, account, here, seen)).filter(Boolean).length;
      // A refresh that read the mailbox's flags before this mark reached it wrote the old state back: said again.
      for (const r of mine) mark.run(seen ? 1 : 0, r.key);
    }).catch((e) => {
      console.error(`[mail-inbox] ${mailboxLabel(hub, account)}: read state ${errCode(e)}`);
    });
  }
  return { ok: rows.length, synced };
}

/**
 * Pin or unpin a kept mail's thread (since 2026-11-21, kept the same as Apple Mail's flag): on the hub at once, then
 * in the mailbox, after any refresh or move that is running: the `\Flagged` flag added to or removed from each of the
 * thread's received messages (its source's setFlagged: that flag only, each message checked again). `synced`: how many
 * the mailbox took. A refresh that read the flags before this reached the mailbox wrote the old pins back: said again.
 */
export async function setPinnedSynced(hub: Hub, key: string, pinned: boolean): Promise<{ ok: boolean; synced: number }> {
  const db = hub.mailDb;
  if (!setPinned(db, key, pinned)) return { ok: false, synced: 0 };
  const members = db.prepare(`SELECT key, account FROM inbox WHERE (${THREAD_OF}) AND state IN ('inbox', 'snoozed', 'done')`).all(key, key) as { key: string; account: string }[];
  let synced = 0;
  for (const account of [...new Set(members.map((m) => m.account))]) {
    const mine = members.filter((m) => m.account === account);
    const source = sourceOf(account);
    if (!source?.setFlagged) continue;
    await exclusive(hub, async () => {
      const now = db.prepare("SELECT id, message_id FROM inbox WHERE key = ?");
      const refs = mine.map((m) => now.get(m.key) as { id: string; message_id: string | null } | undefined).filter((x): x is { id: string; message_id: string | null } => !!x);
      if (!refs.length) return;
      synced += (await source.setFlagged!(hub, account, refs, pinned)).filter(Boolean).length;
      setPinned(db, key, pinned);
    }).catch((e) => console.error(`[mail-inbox] ${mailboxLabel(hub, account)}: pin ${errCode(e)}`));
  }
  return { ok: true, synced };
}

/** A kept mail by its key, in the Inbox's table or a folder's: its mailbox, its folder id and Message-ID. */
function keptRef(db: DB, key: string): { account: string; id: string; message_id: string | null } | null {
  return (db.prepare("SELECT account, id, message_id FROM inbox WHERE key = ?").get(key) as { account: string; id: string; message_id: string | null } | undefined)
    ?? (db.prepare("SELECT account, id, message_id FROM folder_mail WHERE key = ?").get(key) as { account: string; id: string; message_id: string | null } | undefined)
    ?? null;
}

/**
 * A kept mail's attachments now (since 2026-11-21), with its pictures' previews: read from the mailbox when the owner
 * opens the mail (read-only, the message checked again), kept in memory only; the list (no previews) is kept with the
 * mail for its paperclip. Null when the mail is not kept, or not in the mailbox any more.
 */
export async function mailAttachments(hub: Hub, key: string): Promise<(MailAttachment & { preview?: string })[] | null> {
  const r = keptRef(hub.mailDb, key);
  const source = r ? sourceOf(r.account) : null;
  if (!r || !source?.attachments) return null;
  const list = await source.attachments(hub, r.account, { id: r.id, message_id: r.message_id });
  if (list) {
    const plain = JSON.stringify(list.map(({ part, name, type, size }) => ({ part, name, type, size })));
    hub.mailDb.prepare("UPDATE inbox SET attachments = ? WHERE key = ?").run(plain, key);
    hub.mailDb.prepare("UPDATE folder_mail SET attachments = ? WHERE key = ?").run(plain, key);
  }
  return list;
}

/** One attachment's bytes for a download the owner asked for (read-only, never kept); null when it is not there. */
export async function mailAttachment(hub: Hub, key: string, part: string): Promise<{ name: string; bytes: Buffer } | null> {
  if (!/^\d{1,3}(\.\d{1,3}){0,9}$/.test(part)) return null;
  const r = keptRef(hub.mailDb, key);
  const source = r ? sourceOf(r.account) : null;
  if (!r || !source?.attachment) return null;
  const file = await source.attachment(hub, r.account, { id: r.id, message_id: r.message_id }, part);
  if (file) console.log(`[mail-inbox] ${mailboxLabel(hub, r.account)}: 1 attachment downloaded`);
  return file;
}

// ---------------------------------------------------------------------------------------------------------------------
// Unsubscribe and block (since 2026-11-21)

/** The one-click POST, swappable in tests. */
export const oneClick = { post: postOneClick };

/** A kept mail's unsubscribe ways, read from the mailbox now; whether this hub would go through Tor. Null when gone. */
export async function unsubscribeOptions(hub: Hub, key: string): Promise<{ one_click?: { host: string }; link?: string; mailto?: { to: string; subject: string }; tor: boolean } | null> {
  const r = keptRef(hub.mailDb, key);
  const source = r ? sourceOf(r.account) : null;
  if (!r || !source?.unsubscribeHeaders) return null;
  const h = await source.unsubscribeHeaders(hub, r.account, { id: r.id, message_id: r.message_id });
  if (!h) return null;
  const w = unsubscribeWays(h.header, h.post);
  return { ...(w.one_click ? { one_click: { host: new URL(w.one_click).hostname } } : {}), ...(w.link ? { link: w.link } : {}), ...(w.mailto ? { mailto: w.mailto } : {}), tor: !!hub.cfg.torSocks };
}

/**
 * Unsubscribe the way the owner chose, from what the mail's headers say now (never from the request): `one_click`
 * POSTs to the mail's https address, through Tor when the hub has it; without Tor only with `direct` (the owner was told
 * the sender sees the home's address) and only to a public address. `mailto` saves a draft to the mail's unsubscribe
 * address, for the owner to send.
 */
export async function unsubscribe(hub: Hub, key: string, how: unknown, direct: boolean): Promise<{ ok: boolean; via?: "tor" | "direct"; draft?: boolean }> {
  const r = keptRef(hub.mailDb, key);
  const source = r ? sourceOf(r.account) : null;
  if (!r || !source?.unsubscribeHeaders) throw new StoreError(404, "that message is not kept (it left the Inbox)");
  const h = await source.unsubscribeHeaders(hub, r.account, { id: r.id, message_id: r.message_id });
  if (!h) throw new StoreError(404, "This mail is not in the mailbox any more. Refresh and try again.");
  const w = unsubscribeWays(h.header, h.post);
  const label = mailboxLabel(hub, r.account);
  if (how === "one_click") {
    if (!w.one_click) throw new StoreError(409, "This mail has no one-click unsubscribe.");
    const socks = hub.cfg.torSocks;
    if (!socks && !direct) throw new StoreError(409, "This hub has no Tor: unsubscribing would show the sender your home's internet address. Confirm to go ahead.");
    let ok: boolean;
    try { ok = await oneClick.post(w.one_click, socks); } catch (e) { if (e instanceof TorDown) throw new StoreError(503, "Tor is not answering on the hub, so nothing was sent. Try again later."); throw e; }
    console.log(`[mail-inbox] ${label}: unsubscribe one-click ${ok ? "sent" : "refused"} (${socks ? "tor" : "direct"})`);
    if (!ok) throw new StoreError(502, "The sender did not accept the unsubscribe. Try its own link instead, from the mail.");
    return { ok: true, via: socks ? "tor" : "direct" };
  }
  if (how === "mailto") {
    if (!w.mailto) throw new StoreError(409, "This mail has no unsubscribe address.");
    await saveMailDraft(hub, { to: w.mailto.to, subject: w.mailto.subject, text: "unsubscribe", from: r.account.slice(r.account.indexOf(":") + 1) });
    return { ok: true, draft: true };
  }
  throw new StoreError(422, "how is one_click or mailto");
}

/** The owner's blocked senders: addresses and `@domain`s. */
export function blockedSenders(db: DB): string[] {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'blocked_senders'").get() as { value: string } | undefined;
  try { return r ? (JSON.parse(r.value) as unknown[]).filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
const saveBlocked = (db: DB, list: string[]) => db.prepare("INSERT INTO settings (key, value) VALUES ('blocked_senders', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(list));
export const BLOCKED_MAX = 200;

/** The kept Inbox and snoozed mail from blocked senders (never the owner's own). */
function blockedKeys(db: DB, blocked: string[], account?: string): string[] {
  if (!blocked.length) return [];
  const rows = db.prepare(`SELECT key, from_address FROM inbox WHERE state IN ('inbox', 'snoozed') AND mine = 0${account ? " AND account = ?" : ""}`).all(...(account ? [account] : [])) as { key: string; from_address: string }[];
  return rows.filter((r) => isBlocked(blocked, r.from_address)).map((r) => r.key);
}

/** Block a sender (an address or `@domain`): kept; their mail in the Inbox moves to Spam now, and new mail at each refresh. */
export async function blockSender(hub: Hub, sender: unknown): Promise<{ blocked: string[]; moved: number }> {
  const s = blockedForm(sender);
  if (!s) throw new StoreError(422, "sender is an email address or @domain");
  const list = blockedSenders(hub.mailDb);
  if (!list.includes(s)) {
    if (list.length >= BLOCKED_MAX) throw new StoreError(409, `at most ${BLOCKED_MAX} blocked senders`);
    saveBlocked(hub.mailDb, [...list, s]);
  }
  const keys = blockedKeys(hub.mailDb, [s]);
  const r = keys.length ? await moveMail(hub, keys, "junk") : { moved: [] as string[] };
  return { blocked: blockedSenders(hub.mailDb), moved: r.moved.length };
}

export function unblockSender(db: DB, sender: unknown): string[] {
  const s = blockedForm(sender);
  if (!s) throw new StoreError(422, "sender is an email address or @domain");
  saveBlocked(db, blockedSenders(db).filter((x) => x !== s));
  return blockedSenders(db);
}

// ---------------------------------------------------------------------------------------------------------------------
// Triage (since 2026-11-21)

/** Whether triage is on (the owner's switch, on unless turned off). */
export const triageOn = (db: DB) => (db.prepare("SELECT value FROM settings WHERE key = 'mail_triage'").get() as { value: string } | undefined)?.value !== "off";

/** Triage on or off; off also erases every kept triage. */
export function setTriage(db: DB, on: boolean): boolean {
  db.prepare("INSERT INTO settings (key, value) VALUES ('mail_triage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? "on" : "off");
  if (!on && db.prepare("UPDATE inbox SET triage = NULL, triaged_at = NULL WHERE triage IS NOT NULL").run().changes) db.pragma("wal_checkpoint(TRUNCATE)");
  return on;
}

const triaging = new WeakMap<Hub, Promise<number>>();

/**
 * Triage new Inbox mail (received, of the last TRIAGE_DAYS, not triaged yet), newest first, at most TRIAGE_BATCH a run,
 * with the local model in the background (it gives way to a chat, and waits while a game has the card). One run at a
 * time. Stops at the first mail the model does not answer (it is tried at the next run); an answer it cannot read is
 * kept as fyi so it is not asked again.
 */
export function triageNew(hub: Hub, now = new Date()): Promise<number> {
  const busy = triaging.get(hub);
  if (busy) return busy;
  const run = (async () => {
    const db = hub.mailDb;
    if (!triageOn(db)) return 0;
    const name = hub.profile.get().name.trim();
    const owner = name && name !== "the owner" ? name : "the owner";
    const since = new Date(now.getTime() - TRIAGE_DAYS * DAY_MS).toISOString();
    const rows = db.prepare("SELECT key, from_name, from_address, subject, text FROM inbox WHERE state = 'inbox' AND mine = 0 AND triage IS NULL AND at >= ? ORDER BY at DESC LIMIT ?").all(since, TRIAGE_BATCH) as { key: string; from_name: string; from_address: string; subject: string; text: string }[];
    const save = db.prepare("UPDATE inbox SET triage = ?, triaged_at = ? WHERE key = ?");
    let done = 0;
    for (const r of rows) {
      const { text, stopped } = await hub.ai.backgroundJson("mail-triage", TRIAGE_SYSTEM.replaceAll("{{owner}}", owner), triagePrompt({ ...r, text: ownWords(r.text.slice(0, 6000)) }));
      if (stopped || text === null) break;
      save.run(JSON.stringify(readTriage(text)), new Date().toISOString(), r.key);
      done++;
    }
    if (done) console.log(`[mail-inbox] triage: ${done} mails`);
    return done;
  })().finally(() => triaging.delete(hub));
  triaging.set(hub, run);
  return run;
}

// ---------------------------------------------------------------------------------------------------------------------
// "Something important missing?" (since 2026-11-22): folding notes, kept with the mail, never sent anywhere

/** At most this many lines in a note, each at most this long. */
export const NOTE_LINES = 8;
const NOTE_LINE_MAX = 300;

/**
 * The owner says the fold hid something in a kept mail: `lines` (each a whole line of the mail's folded part, checked
 * here, at most NOTE_LINES) and `no_fold` (show this mail unfolded, its preview too). The note keeps the line the fold
 * started at, for turning into a made-up test; it lives in the mail's own row, so it goes when the mail goes.
 */
export function saveFoldNote(db: DB, key: string, body: Record<string, unknown>): FoldNote {
  const r = db.prepare("SELECT text FROM inbox WHERE key = ?").get(key) as { text: string } | undefined;
  if (!r) throw new StoreError(404, "that message is not kept (it left the Inbox)");
  const at = quoteStart(r.text);
  const folded = at >= 0 ? r.text.slice(at).split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const lines = body.lines === undefined ? [] : body.lines;
  if (!Array.isArray(lines) || lines.length > NOTE_LINES || !lines.every((l) => typeof l === "string" && l.length <= NOTE_LINE_MAX && folded.includes(l.trim()))) {
    throw new StoreError(422, `lines are at most ${NOTE_LINES} lines of the mail's folded part`);
  }
  if (body.no_fold !== undefined && typeof body.no_fold !== "boolean") throw new StoreError(422, "no_fold is true or false");
  const note: FoldNote = { cut: (folded[0] ?? "").slice(0, NOTE_LINE_MAX), lines: (lines as string[]).map((l) => l.trim()), no_fold: body.no_fold === true, at: new Date().toISOString() };
  db.prepare("UPDATE inbox SET fold_note = ? WHERE key = ?").run(JSON.stringify(note), key);
  return note;
}

/** Every kept folding note, newest first: the mail it is on (id, subject, sender) and the note. */
export function foldNotes(db: DB): { id: string; subject: string; from: string; note: FoldNote }[] {
  const rows = db.prepare("SELECT key, subject, from_address, fold_note FROM inbox WHERE fold_note IS NOT NULL").all() as { key: string; subject: string; from_address: string; fold_note: string }[];
  return rows.map((r) => ({ id: r.key, subject: r.subject, from: r.from_address, note: foldNoteOf(r.fold_note)! })).filter((x) => x.note).sort((a, b) => b.note.at.localeCompare(a.note.at));
}

/** Clear the notes: `all`, or one mail's; with `keep_unfolded`, a mail the owner said not to fold stays unfolded. */
export function clearFoldNotes(db: DB, key?: string): number {
  return (key ? db.prepare("UPDATE inbox SET fold_note = NULL WHERE key = ?").run(key) : db.prepare("UPDATE inbox SET fold_note = NULL WHERE fold_note IS NOT NULL").run()).changes;
}

/**
 * Pins made before pins were kept as flags (2026-11-21): flagged in the mailbox once, before the first refresh that reads
 * the flags, so that refresh does not take them away. Marked done per mailbox in `settings` (`pins_flagged:<account>`).
 */
async function flagOldPins(hub: Hub, account: string): Promise<void> {
  const db = hub.mailDb;
  const done = `pins_flagged:${account}`;
  if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(done)) return;
  const source = sourceOf(account);
  if (!source?.setFlagged) return;
  const refs = db.prepare("SELECT id, message_id FROM inbox WHERE account = ? AND pinned = 1 AND state IN ('inbox', 'snoozed', 'done')").all(account) as { id: string; message_id: string | null }[];
  for (const part of [...Array(Math.ceil(refs.length / MOVE_MAX)).keys()].map((i) => refs.slice(i * MOVE_MAX, (i + 1) * MOVE_MAX))) await source.setFlagged(hub, account, part, true);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(done, new Date().toISOString());
  if (refs.length) console.log(`[mail-inbox] ${mailboxLabel(hub, account)}: ${refs.length} pins flagged in the mailbox`);
}

export async function setSeen(hub: Hub, key: string, seen: boolean): Promise<{ ok: boolean; synced: boolean }> {
  const r = await setSeenMany(hub, [key], seen);
  return { ok: r.ok === 1, synced: r.synced === 1 };
}

/** `text`: the whole text saved, the greeting and sign-off around the owner's own words. */
export interface DraftResult { saved: boolean; from: MailAddress; to: string[]; cc?: string[]; subject: string; text: string; in_reply_to?: string; files?: { name: string; size: number }[] }

/**
 * Write mail as a draft (mail-compose.ts): a reply to a kept mail (`reply_to`, its id), or a new mail (`to`, `subject`,
 * and `from` when several mailboxes are linked). A reply's recipient, subject and thread come from the kept mail, never
 * from the request. With `preview`, the hub says what it would save and saves nothing (the screen shows the whole mail
 * before it is saved); otherwise the draft goes to the mailbox's Drafts folder, after any refresh or move that is
 * running. The owner sends it from their mail app: nothing here sends mail.
 */
export async function saveMailDraft(hub: Hub, body: Record<string, unknown>): Promise<DraftResult> {
  const db = hub.mailDb;
  // A forward may go without a note of its own (the forwarded mail is its text); anything else needs the owner's words.
  const typed = body.forward !== undefined && (body.text === undefined || body.text === "") ? "" : checkedText(body.text);
  // The greeting and sign-off (suggested, then edited or dropped by the owner) are checked again here: short plain words.
  const line = (v: unknown, what: string) => {
    if (v === undefined || v === null || v === "") return null;
    const ok = checkedLine(v);
    if (!ok) throw new StoreError(422, `${what} is at most 2 short lines of plain words: no links, addresses or long numbers`);
    return ok;
  };
  let text = assembled(typed, line(body.greeting, "the greeting"), line(body.signoff, "the sign-off"));
  if (text.length > DRAFT_TEXT_MAX + 200) throw new StoreError(422, "the mail is too long");
  let account: string | undefined;
  let fields: ReturnType<typeof replyFields> & { cc?: string[] };
  if (body.forward !== undefined) {
    // Forward: the owner's recipients (typed, checked as a new mail's), the kept mail's subject and words below.
    if (typeof body.forward !== "string") throw new StoreError(422, "forward is a mail's id");
    type Fwd = { account: string; from_name: string; from_address: string; subject: string; text: string; at: string; to_list?: string | null };
    const m = (db.prepare("SELECT account, from_name, from_address, subject, text, at FROM inbox WHERE key = ?").get(body.forward) as Fwd | undefined)
      ?? (db.prepare("SELECT account, from_name, from_address, subject, text, at, to_list FROM folder_mail WHERE key = ?").get(body.forward) as Fwd | undefined);
    if (!m) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    const typedTo = checkedNew({ to: body.to });
    let to: MailAddress[] = [];
    try { to = m.to_list ? (JSON.parse(m.to_list) as MailAddress[]) : []; } catch { to = []; }
    account = m.account;
    fields = { to: typedTo.to, subject: forwardSubject(m.subject) };
    text = [text, forwardQuote({ from: { name: m.from_name, address: m.from_address }, at: m.at, subject: m.subject, to, text: m.text })].filter(Boolean).join("\n\n");
  } else if (body.reply_to !== undefined) {
    if (typeof body.reply_to !== "string") throw new StoreError(422, "reply_to is a mail's id");
    const r = db.prepare("SELECT account, from_address, subject, message_id, refs, mine FROM inbox WHERE key = ?").get(body.reply_to) as { account: string; from_address: string; subject: string; message_id: string | null; refs: string | null; mine: number } | undefined;
    if (!r) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    if (r.mine) throw new StoreError(422, "that is your own reply: answer the other person's mail in the thread");
    let refs: string[] = [];
    try { refs = r.refs ? (JSON.parse(r.refs) as unknown[]).filter((x): x is string => typeof x === "string") : []; } catch { /* none */ }
    account = r.account;
    fields = replyFields({ from_address: r.from_address, subject: r.subject, message_id: r.message_id, refs });
    // Reply all: everyone else on the mail, as the mailbox has its To and Cc now, never from the request.
    if (body.reply_all === true) {
      const kept = db.prepare("SELECT id, message_id FROM inbox WHERE key = ?").get(body.reply_to) as { id: string; message_id: string | null };
      const source = sourceOf(r.account);
      if (!source?.recipients) throw new StoreError(409, "this mailbox cannot say who a mail went to");
      const who = await source.recipients(hub, r.account, kept);
      if (!who) throw new StoreError(404, "This mail is not in the mailbox any more. Refresh and try again.");
      const mine = INBOX_SOURCES.flatMap((s) => s.accounts(hub)).map((a) => a.slice(a.indexOf(":") + 1));
      const cc = replyAllCc([...who.to, ...who.cc], [...mine, ...fields.to]);
      if (cc.length) fields = { ...fields, cc };
    }
  } else {
    fields = checkedNew(body);
    const all = INBOX_SOURCES.flatMap((s) => s.accounts(hub));
    const from = typeof body.from === "string" ? body.from.trim().toLowerCase() : "";
    account = from ? all.find((a) => a.slice(a.indexOf(":") + 1) === from) : all[0];
    if (!account) throw new StoreError(from ? 422 : 409, from ? "that address is not a linked mailbox" : "link an iCloud mailbox first");
  }
  const source = sourceOf(account);
  if (!source?.saveDraft) throw new StoreError(409, "this mailbox cannot keep drafts from Aeneas");
  const name = hub.profile.get().name.trim();
  const from: MailAddress = { name: name && name !== "the owner" ? name : "", address: account.slice(account.indexOf(":") + 1) };
  // Files: the owner's own (checked), and a forwarded mail's when asked (read from the mailbox now, read-only), 15 MB in all.
  const files: DraftFile[] = checkedFiles(body.files);
  if (body.forward !== undefined && body.forward_attachments === true && body.preview !== true) {
    const r = keptRef(db, body.forward as string);
    const src = r ? sourceOf(r.account) : null;
    const list = r && src?.attachments ? (await src.attachments(hub, r.account, { id: r.id, message_id: r.message_id })) ?? [] : [];
    let total = files.reduce((n, f) => n + f.bytes.length, 0);
    for (const a of list.slice(0, FILES_MAX - files.length)) {
      const f = await src!.attachment!(hub, r!.account, { id: r!.id, message_id: r!.message_id }, a.part);
      if (!f) continue;
      total += f.bytes.length;
      if (total > FILES_BYTES) throw new StoreError(413, "The mail's attachments are more than 15 MB together. Forward it from Apple Mail (Mail Drop).");
      files.push({ name: f.name, type: a.type, bytes: f.bytes });
    }
  }
  // Editing a draft: the old one is moved to Trash once the new one is saved; its Cc and thread go on.
  let replaces: { id: string; message_id: string | null } | null = null;
  if (body.replaces !== undefined) {
    if (typeof body.replaces !== "string") throw new StoreError(422, "replaces is a draft's id");
    const d = db.prepare("SELECT m.account, m.id, m.message_id FROM folder_mail m JOIN folders f ON f.account = m.account AND f.path = m.folder WHERE m.key = ? AND f.role = 'drafts'").get(body.replaces) as { account: string; id: string; message_id: string | null } | undefined;
    if (!d || d.account !== account) throw new StoreError(404, "that draft is not in Drafts any more");
    const src = sourceOf(d.account);
    const old = src?.recipients ? await src.recipients(hub, d.account, d) : null;
    if (!old) throw new StoreError(404, "that draft is not in Drafts any more");
    const mine = INBOX_SOURCES.flatMap((s) => s.accounts(hub)).map((a) => a.slice(a.indexOf(":") + 1));
    const cc = replyAllCc(old.cc, [...mine, ...fields.to]);
    fields = { ...fields, ...(cc.length ? { cc } : {}), ...(old.in_reply_to ? { in_reply_to: old.in_reply_to } : {}), ...(old.answers.length ? { references: old.answers.slice(-10) } : {}) };
    replaces = d;
  }
  const out: DraftResult = { saved: false, from, to: fields.to, ...(fields.cc?.length ? { cc: fields.cc } : {}), subject: fields.subject, text, ...(fields.in_reply_to ? { in_reply_to: fields.in_reply_to } : {}), ...(files.length ? { files: files.map((f) => ({ name: f.name, size: f.bytes.length })) } : {}) };
  if (body.preview === true) return out;
  const { raw } = buildMessage({ from, text, ...fields, files });
  const label = mailboxLabel(hub, account);
  await exclusive(hub, () => source.saveDraft!(hub, account!, raw)).catch((e) => {
    console.error(`[mail-inbox] ${label}: draft not saved ${errCode(e)}`);
    throw e;
  });
  console.log(`[mail-inbox] ${label}: 1 draft saved${files.length ? `, ${files.length} files` : ""}`);
  // The old version of an edited draft: to Trash (MOVE, nothing erased), and out of the hub's Drafts at once.
  if (replaces && source.moveTo) {
    const moved = await exclusive(hub, () => source.moveTo!(hub, account!, [replaces!], { role: "trash" })).catch((e) => { console.error(`[mail-inbox] ${label}: old draft not moved ${errCode(e)}`); return null; });
    if (moved?.get(replaces.id)) db.prepare("DELETE FROM folder_mail WHERE key = ?").run(body.replaces as string);
  }
  return { ...out, saved: true };
}

/**
 * The greeting and sign-off for a reply to a kept mail, suggested by the local model (never a cloud one) from the
 * owner's name and the thread's latest messages, their own words only. Nothing else of the owner's goes to it: no
 * memory facts, no records. What it writes is checked (checkedLine); without the model, or for what fails the check,
 * the plain ones ("Hi Alex," and "Thanks, Robin"). The owner sees both in the reply, and edits or drops them.
 */
export async function suggestGreeting(hub: Hub, key: string): Promise<{ greeting: string; signoff: string; by: "model" | "plain"; replies: string[] }> {
  const db = hub.mailDb;
  const r = db.prepare("SELECT from_name, from_address, thread, mine FROM inbox WHERE key = ?").get(key) as { from_name: string; from_address: string; thread: string | null; mine: number } | undefined;
  if (!r) throw new StoreError(404, "that message is not kept (it left the Inbox)");
  if (r.mine) throw new StoreError(422, "that is your own reply: answer the other person's mail in the thread");
  const name = hub.profile.get().name.trim();
  const owner = name && name !== "the owner" ? name : "";
  const plain = plainGreeting({ name: r.from_name, address: r.from_address }, owner);
  const rows = (r.thread
    ? db.prepare("SELECT from_name, from_address, subject, text, mine, at FROM inbox WHERE thread = ? AND at <= (SELECT at FROM inbox WHERE key = ?) ORDER BY at DESC, key LIMIT 4").all(r.thread, key)
    : db.prepare("SELECT from_name, from_address, subject, text, mine, at FROM inbox WHERE key = ?").all(key)) as { from_name: string; from_address: string; subject: string; text: string; mine: number }[];
  const messages = rows.reverse().map((m) => ({ mine: !!m.mine, from: { name: m.from_name, address: m.from_address }, subject: m.subject, text: ownWords(m.text.slice(0, 4000)) }));
  const system = GREETING_SYSTEM.replaceAll("{{owner}}", owner || "the owner");
  const raw = await withPriority("filing", () => hub.ai.completeJson(`mail-greeting`, system, greetingPrompt(owner || "the owner", messages), { allow_cloud: false })).catch(() => null);
  const out = readSuggestion(raw, plain);
  console.log(`[mail-inbox] greeting suggested (${out.by})`);
  return out;
}

/** Pin or unpin a kept mail: it stays where it is in the list, shows with a pin, and Sweep passes it by. */
export function setPinned(db: DB, key: string, pinned: boolean): boolean {
  return db.prepare(`UPDATE inbox SET pinned = ? WHERE ${THREAD_OF}`).run(pinned ? 1 : 0, key, key).changes > 0;
}

/** The verified logos the kept mail uses, by domain, as data: SVG pictures (one each, however many mails). */
export function mailLogos(db: DB): Record<string, string> {
  const rows = db.prepare("SELECT domain, svg FROM logos WHERE svg IS NOT NULL AND domain IN (SELECT logo_domain FROM inbox)").all() as { domain: string; svg: string }[];
  return Object.fromEntries(rows.map((r) => [r.domain, r.svg]));
}

/**
 * One message with its whole kept text and its page, or null. `byTor`: this hub fetches web pictures itself (through
 * Tor), so pictures not there yet are on their way; otherwise they wait for the person to ask.
 */
export function mailMessage(db: DB, key: string, byTor = true): MailMessage | null {
  const r = db.prepare("SELECT key, at, from_name, from_address, reply_to, subject, text, automated, bundle, state, pinned, snooze_until, html, remote, seen, mine, cards, fold_note FROM inbox WHERE key = ?").get(key) as (Row & { html: string | null; remote: string | null }) | undefined;
  if (!r) return folderMessage(db, key);
  // The owner said not to fold this mail: no quote_at, and clients leave its page unfolded (no_fold).
  const quote = noFold(r.fold_note) ? -1 : quoteStart(r.text);
  return { ...summary(r), text: r.text, html: r.html ? mailDocument(withImages(r.html, [])) : null, pictures_pending: !!r.remote && byTor, pictures_ask: !!r.remote && !byTor, ...(quote >= 0 ? { quote_at: quote } : {}), ...(noFold(r.fold_note) ? { no_fold: true } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The other folders (since 2026-11-20): Drafts, Sent, Junk, Trash and the owner's own, kept like the Inbox

/** At most this many messages kept of one folder (the newest). */
export const FOLDER_KEEP = 500;
/** A folder's id in the API: shows nothing of its name. */
export const folderKey = (account: string, path: string) => crypto.createHash("sha256").update(`folder\n${account}\n${path}`).digest("hex").slice(0, 16);

/** Whether a folder message is kept already by its folder id. */
export function isKeptInFolder(db: DB, account: string): (id: string) => boolean {
  const has = db.prepare("SELECT 1 FROM folder_mail WHERE account = ? AND id = ?");
  return (id) => !!has.get(account, id);
}

/**
 * Keep one refresh of a mailbox's other folders, in one transaction: the folder list as it is now (a folder gone takes
 * its mail with it), each folder's new mail, read flags, and what is no longer in it (or older than the listing's
 * time) goes; then at most FOLDER_KEEP of each, the newest.
 */
export function keepFolders(db: DB, account: string, listings: FolderListing[]): { kept: number; gone: number } {
  let kept = 0;
  let gone = 0;
  db.transaction(() => {
    const paths = new Set(listings.map((l) => l.path));
    for (const r of db.prepare("SELECT path FROM folders WHERE account = ?").all(account) as { path: string }[]) {
      if (paths.has(r.path)) continue;
      gone += db.prepare("DELETE FROM folder_mail WHERE account = ? AND folder = ?").run(account, r.path).changes;
      db.prepare("DELETE FROM folders WHERE account = ? AND path = ?").run(account, r.path);
    }
    const saveFolder = db.prepare("INSERT INTO folders (account, path, key, role, more) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account, path) DO UPDATE SET role = excluded.role, more = excluded.more");
    const insert = db.prepare(`INSERT OR IGNORE INTO folder_mail (account, id, key, folder, message_id, at, from_name, from_address, to_list, reply_to, subject, text, automated, html, seen, attachments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const mark = db.prepare("UPDATE folder_mail SET seen = ? WHERE account = ? AND id = ? AND seen != ?");
    const del = db.prepare("DELETE FROM folder_mail WHERE account = ? AND id = ?");
    for (const l of listings) {
      saveFolder.run(account, l.path, folderKey(account, l.path), l.role, l.more ? 1 : 0);
      const read = new Set(l.seen);
      for (const m of l.mails) {
        kept += insert.run(account, m.id, mailKey(account, m.id), l.path, m.message_id, m.at.toISOString(), m.from.name, m.from.address, JSON.stringify(m.to),
          m.reply_to, m.subject, m.text, m.automated ? 1 : 0, m.html, read.has(m.id) ? 1 : 0, m.attachments ? JSON.stringify(m.attachments) : null).changes;
      }
      for (const id of l.present) { const v = read.has(id) ? 1 : 0; mark.run(v, account, id, v); }
      const here = new Set(l.present);
      for (const r of db.prepare("SELECT id FROM folder_mail WHERE account = ? AND folder = ?").all(account, l.path) as { id: string }[]) {
        if (!here.has(r.id)) gone += del.run(account, r.id).changes;
      }
      gone += db.prepare("DELETE FROM folder_mail WHERE account = ? AND folder = ? AND key NOT IN (SELECT key FROM folder_mail WHERE account = ? AND folder = ? ORDER BY at DESC LIMIT ?)").run(account, l.path, account, l.path, FOLDER_KEEP).changes;
    }
  }).immediate();
  if (gone) db.pragma("wal_checkpoint(TRUNCATE)");
  return { kept, gone };
}

/** One folder on the Mail screen: its id, the mailbox it is in, its part, its name (for `own`), how many kept and unread. */
export interface MailFolder { key: string; email: string; role: FolderRole; name: string; count: number; unread: number; more: boolean }
const ROLE_ORDER: Record<string, number> = { drafts: 0, sent: 1, junk: 2, trash: 3, own: 4 };

/** Every kept folder: Drafts, Sent, Junk, Trash, then the owner's own by name. */
export function mailFolders(db: DB): MailFolder[] {
  const rows = db.prepare("SELECT f.key, f.account, f.path, f.role, f.more, count(m.key) AS count, coalesce(sum(CASE WHEN m.seen = 0 THEN 1 ELSE 0 END), 0) AS unread FROM folders f LEFT JOIN folder_mail m ON m.account = f.account AND m.folder = f.path GROUP BY f.key").all() as { key: string; account: string; path: string; role: FolderRole; more: number; count: number; unread: number }[];
  return rows
    .map((r) => ({ key: r.key, email: r.account.slice(r.account.indexOf(":") + 1), role: r.role, name: r.path.split(/[/.]/).pop() || r.path, count: r.count, unread: r.unread, more: !!r.more }))
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

type FolderRow = { key: string; at: string; from_name: string; from_address: string; to_list: string; reply_to: string | null; subject: string; text: string; automated: number; seen: number; role: FolderRole; attachments?: string | null };
const toList = (s: string): MailAddress[] => { try { return (JSON.parse(s) as MailAddress[]).filter((a) => a && typeof a.address === "string"); } catch { return []; } };
export type FolderMailSummary = MailSummary & { to: MailAddress[]; folder_role: FolderRole };
function folderSummary(r: FolderRow): FolderMailSummary {
  return {
    id: r.key, at: r.at, from: { name: r.from_name, address: r.from_address }, ...(r.reply_to ? { reply_to: r.reply_to } : {}),
    to: toList(r.to_list), subject: r.subject, preview: previewOf(r.text), automated: !!r.automated, bundle: null, state: "folder", pinned: false, seen: !!r.seen,
    folder_role: r.role, ...(r.role === "sent" || r.role === "drafts" ? { mine: true } : {}),
    ...(r.attachments == null ? { attachments: null } : attachmentCount(r.attachments) ? { attachments: attachmentCount(r.attachments) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Search (since 2026-11-21): every kept mail, Inbox and folders, its whole text

/** One search hit: a list entry with where it is and a snippet around the first match. */
export type SearchHit = MailSummary & { where: MailState | FolderRole; folder_name?: string; snippet: string; to?: MailAddress[] };
export const SEARCH_MAX = 200;

/** `%`, `_` and `\` in what the owner typed are themselves in a LIKE pattern (ESCAPE '\'). */
const likeWord = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** A line of a mail's text around `word` (its first match), links' addresses out, at most 200 characters; else its start. */
export function snippetOf(text: string, word: string | undefined): string {
  const flat = text.replace(/(https?:\/\/|www\.)[^\s)]+/gi, "").replace(/\s+/g, " ").trim();
  const at = word ? flat.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (at < 0) return flat.slice(0, 200);
  const start = Math.max(0, at - 60);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 200)}`;
}

/**
 * Every kept mail (the Inbox, Snoozed, Done, the owner's replies in threads, and every kept folder) that has each word
 * of `q` in its subject, text, sender's name or address (case aside), newest first, at most SEARCH_MAX. `with`: only
 * mail with that person: from them, or the owner's to them (Sent and Drafts by To; the owner's replies in a thread of
 * theirs). The words are parameters, never part of the query.
 */
export function searchMail(db: DB, opts: { q?: string; with?: string }): SearchHit[] {
  const words = (opts.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).map((w) => w.slice(0, 60));
  const person = (opts.with ?? "").trim().toLowerCase();
  if (!words.length && !person) return [];
  const match = words.map(() => "(lower(subject) LIKE ? ESCAPE '\\' OR lower(text) LIKE ? ESCAPE '\\' OR lower(from_name) LIKE ? ESCAPE '\\' OR lower(from_address) LIKE ? ESCAPE '\\')");
  const params = words.flatMap((w) => Array(4).fill(likeWord(w)));
  // The Inbox's table: received mail from them, and the owner's replies in a thread that has their mail.
  const inboxWith = person ? " AND (from_address = ? OR (mine = 1 AND thread IN (SELECT thread FROM inbox WHERE from_address = ? AND thread IS NOT NULL)))" : "";
  const inboxRows = db.prepare(`SELECT key, at, from_name, from_address, reply_to, subject, text, automated, bundle, state, pinned, snooze_until, logo_domain, back_at, seen, thread, mine, cards, attachments FROM inbox WHERE 1 = 1${match.length ? ` AND ${match.join(" AND ")}` : ""}${inboxWith} ORDER BY at DESC LIMIT ?`)
    .all(...params, ...(person ? [person, person] : []), SEARCH_MAX) as (Row & { attachments?: string | null })[];
  // The folders: from them, or the owner's own to them (To holds them).
  const folderWith = person ? " AND (m.from_address = ? OR (f.role IN ('sent', 'drafts') AND lower(m.to_list) LIKE ? ESCAPE '\\'))" : "";
  const folderRows = db.prepare(`SELECT m.key, m.at, m.from_name, m.from_address, m.to_list, m.reply_to, m.subject, m.text, m.automated, m.seen, m.attachments, f.role, f.path FROM folder_mail m JOIN folders f ON f.account = m.account AND f.path = m.folder WHERE 1 = 1${match.length ? ` AND ${match.map((x) => x.replace(/(subject|text|from_name|from_address)/g, "m.$1")).join(" AND ")}` : ""}${folderWith} ORDER BY m.at DESC LIMIT ?`)
    .all(...params, ...(person ? [person, likeWord(`"address":"${person}"`)] : []), SEARCH_MAX) as (FolderRow & { path: string })[];
  const hits: SearchHit[] = [
    ...inboxRows.map((r) => ({ ...summary(r), where: r.state, snippet: snippetOf(r.text, words[0]) })),
    ...folderRows.map((r) => ({ ...folderSummary(r), where: r.role, ...(r.role === "own" ? { folder_name: r.path.split(/[/.]/).pop() || r.path } : {}), snippet: snippetOf(r.text, words[0]) })),
  ];
  return hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, SEARCH_MAX);
}

/** A folder's kept mail, newest first; null when there is no such folder. */
export function folderMail(db: DB, key: string): FolderMailSummary[] | null {
  const f = db.prepare("SELECT account, path, role FROM folders WHERE key = ?").get(key) as { account: string; path: string; role: FolderRole } | undefined;
  if (!f) return null;
  const rows = db.prepare("SELECT key, at, from_name, from_address, to_list, reply_to, subject, substr(text, 1, 3000) AS text, automated, seen, attachments FROM folder_mail WHERE account = ? AND folder = ? ORDER BY at DESC, key").all(f.account, f.path) as Omit<FolderRow, "role">[];
  return rows.map((r) => folderSummary({ ...r, role: f.role }));
}

/** One folder message whole, as mailMessage gives Inbox mail; never with web pictures (none are fetched for folders). */
function folderMessage(db: DB, key: string): MailMessage | null {
  const r = db.prepare("SELECT m.key, m.at, m.from_name, m.from_address, m.to_list, m.reply_to, m.subject, m.text, m.automated, m.seen, m.html, f.role FROM folder_mail m JOIN folders f ON f.account = m.account AND f.path = m.folder WHERE m.key = ?").get(key) as (FolderRow & { html: string | null }) | undefined;
  if (!r) return null;
  const quote = quoteStart(r.text);
  return { ...folderSummary(r), text: r.text, html: r.html ? mailDocument(withImages(r.html, [])) : null, pictures_pending: false, pictures_ask: false, ...(quote >= 0 ? { quote_at: quote } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Web pictures

/** A logo at most this big (BIMI's own limit is 32 KB), fetched again after this long; a failed one is tried a day later. */
const LOGO_BYTES = 64 * 1024;
const LOGO_DAYS = 30;

/** Bytes that are an SVG picture: text, starting (after an XML line, comments or a doctype) with an <svg> element. */
export function isSvg(b: Buffer): boolean {
  const head = b.subarray(0, 4096).toString("utf8").replace(/^\uFEFF/, "").replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/gi, "").trimStart();
  return /^<svg[\s>]/i.test(head);
}

/**
 * Fetch the verified logos not fetched yet (or not for LOGO_DAYS), one per brand's domain, through Tor like the
 * pictures. They are shown only as pictures (`<img>`), where an SVG's scripts and links never run.
 */
async function fetchLogos(db: DB, socks: string, now = new Date()): Promise<number> {
  const stale = new Date(now.getTime() - LOGO_DAYS * DAY_MS).toISOString();
  const rows = db.prepare("SELECT domain, url FROM logos WHERE (fetched_at IS NULL OR fetched_at < ?) AND domain IN (SELECT logo_domain FROM inbox) LIMIT 50").all(stale) as { domain: string; url: string }[];
  const save = db.prepare("UPDATE logos SET svg = ?, fetched_at = ? WHERE domain = ? AND url = ?");
  let got = 0;
  for (const r of rows) {
    let b: Buffer | null;
    // Tor is not there: the logos not fetched yet wait for the next run, like the pictures.
    try { b = await mailImages.fetch(r.url, socks); } catch (e) { if (e instanceof TorDown) return got; b = null; }
    if (b && b.length <= LOGO_BYTES && isSvg(b)) {
      save.run(`data:image/svg+xml;base64,${b.toString("base64")}`, now.toISOString(), r.domain, r.url);
      got++;
    } else {
      // Tried again a day later: as if fetched LOGO_DAYS - 1 days ago.
      save.run(null, new Date(now.getTime() - (LOGO_DAYS - 1) * DAY_MS).toISOString(), r.domain, r.url);
    }
  }
  return got;
}

/** Each picture at most this big; a mail's pictures at most this much in all (the rest stay empty). */
const PICTURE_BYTES = 2_000_000;
const MAIL_PICTURE_BYTES = 8_000_000;
/** Pictures fetched at once, and mails done per batch (the module's switch is checked between batches). */
const AT_ONCE = 6;
const BATCH = 10;
/**
 * How a web picture is fetched; both ways https only, no cookie, capped (ai/web.ts). Tests swap them.
 * `fetch`: through Tor, the only way the hub fetches a picture on its own.
 * `direct`: straight from the hub, only for a mail whose pictures the person asked for on a hub without Tor.
 */
export const mailImages = {
  fetch: (url: string, socks: string): Promise<Buffer | null> => fetchBytesViaTor(url, socks, 45_000, PICTURE_BYTES),
  direct: (url: string): Promise<Buffer | null> => fetchPublicBytes(url, 15_000, PICTURE_BYTES),
};
const fetching = new WeakMap<Hub, Promise<number>>();

/**
 * One mail's web pictures, fetched with `get`, as data: addresses in the order of its `remote` list: null for one that
 * failed, is not a PNG, JPEG, GIF or WebP, or would take the mail past MAIL_PICTURE_BYTES. TorDown passes through.
 */
async function picturesOf(remote: string, get: (url: string) => Promise<Buffer | null>): Promise<{ pictures: (string | null)[]; failed: number }> {
  let urls: string[] = [];
  try { urls = (JSON.parse(remote) as unknown[]).filter((u): u is string => typeof u === "string"); } catch { /* none */ }
  const pictures: (string | null)[] = urls.map(() => null);
  let total = 0;
  let failed = 0;
  for (let i = 0; i < urls.length; i += AT_ONCE) {
    const got = await Promise.all(urls.slice(i, i + AT_ONCE).map((u) => get(u).catch((e) => { if (e instanceof TorDown) throw e; failed++; return null; })));
    got.forEach((b, j) => {
      if (!b || total + b.length > MAIL_PICTURE_BYTES) return;
      const data = pictureData(b);
      if (data) { pictures[i + j] = data; total += b.length; }
    });
  }
  return { pictures, failed };
}

/**
 * Fetch the web pictures of every kept mail that still waits for them, newest mail first, through Tor, and write them
 * into its HTML as data: pictures (a picture that fails stays empty). One run at a time per hub; it stops when the
 * module is switched off, and when Tor stops answering (the mail not done yet waits for the next refresh). Resolves to
 * the number of mails done. On a hub without Tor it fetches nothing: see showPictures.
 */
export function fetchMailImages(hub: Hub): Promise<number> {
  const socks = hub.cfg.torSocks;
  if (!socks) return Promise.resolve(0);
  const busy = fetching.get(hub);
  if (busy) return busy;
  const run = (async () => {
    const db = hub.mailDb;
    const next = db.prepare("SELECT key, html, remote FROM inbox WHERE remote IS NOT NULL ORDER BY at DESC LIMIT ?");
    const save = db.prepare("UPDATE inbox SET html = ?, remote = NULL WHERE key = ? AND remote IS NOT NULL");
    const noPictures = db.prepare("UPDATE inbox SET remote = NULL WHERE key = ?");
    let done = 0;
    let failed = 0;
    let down = false;
    while (!down) {
      if (!hub.modules.on("mail_inbox")) break;
      const rows = next.all(BATCH) as { key: string; html: string; remote: string }[];
      if (!rows.length) break;
      for (const r of rows) {
        try {
          const got = await picturesOf(r.remote, (u) => mailImages.fetch(u, socks));
          failed += got.failed;
          save.run(withImages(r.html, got.pictures), r.key);
          done++;
        } catch (e) {
          if (e instanceof TorDown) { down = true; break; }
          // A mail whose pictures cannot be written in keeps none and is not tried again: it must not hold up the
          // mail after it, refresh after refresh.
          console.error(`[mail-inbox] a mail's pictures could not be written in, so it has none: ${errCode(e)}`);
          noPictures.run(r.key);
          done++;
        }
      }
    }
    if (done) console.log(`[mail-inbox] pictures fetched for ${done} mails${failed ? `, ${failed} pictures failed` : ""}`);
    if (down) console.log("[mail-inbox] Tor is not answering: the pictures not fetched yet wait for the next refresh");
    else if (hub.modules.on("mail_inbox")) await fetchLogos(db, socks);
    return done;
  })();
  fetching.set(hub, run);
  void run.finally(() => fetching.delete(hub)).catch(() => {});
  return run;
}

const showing = new WeakMap<Hub, Map<string, Promise<void>>>();

/**
 * Show pictures, pressed on one open mail on a hub without Tor: that mail's web pictures, fetched straight from the hub
 * because the person asked (the screen told them its sender will see the home's internet address), and written in.
 * Only that mail's: no other mail's, and no logo. A hub with Tor never fetches this way (409). Null when the mail is
 * not kept.
 */
export async function showPictures(hub: Hub, key: string): Promise<MailMessage | null> {
  if (hub.cfg.torSocks) throw new StoreError(409, "This hub fetches mail pictures through Tor on its own, and never another way.");
  const db = hub.mailDb;
  const jobs = showing.get(hub) ?? new Map<string, Promise<void>>();
  showing.set(hub, jobs);
  let job = jobs.get(key);
  if (!job) {
    job = (async () => {
      const r = db.prepare("SELECT html, remote FROM inbox WHERE key = ? AND remote IS NOT NULL").get(key) as { html: string; remote: string } | undefined;
      if (!r) return;
      try {
        const got = await picturesOf(r.remote, (u) => mailImages.direct(u));
        db.prepare("UPDATE inbox SET html = ?, remote = NULL WHERE key = ? AND remote IS NOT NULL").run(withImages(r.html, got.pictures), key);
        console.log(`[mail-inbox] pictures fetched for one mail because its owner asked${got.failed ? `, ${got.failed} pictures failed` : ""}`);
      } catch (e) {
        console.error(`[mail-inbox] a mail's pictures could not be written in, so it has none: ${errCode(e)}`);
        db.prepare("UPDATE inbox SET remote = NULL WHERE key = ?").run(key);
      }
    })().finally(() => jobs.delete(key));
    jobs.set(key, job);
  }
  await job;
  return mailMessage(db, key, false);
}

/** Each linked mailbox with when the Mail screen last refreshed it, what went wrong, and whether more is coming. */
export function mailboxStates(hub: Hub): { email: string; last_refresh: string | null; last_error: string | null; more: boolean }[] {
  const get = hub.mailDb.prepare("SELECT last_refresh, last_error, more FROM mailboxes WHERE account = ?");
  return INBOX_SOURCES.flatMap((source) => source.accounts(hub).map((account) => {
    const s = get.get(account) as { last_refresh: string | null; last_error: string | null; more: number } | undefined;
    return { email: account.slice(source.prefix.length), last_refresh: s?.last_refresh ?? null, last_error: s?.last_error ?? null, more: !!s?.more };
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Refresh

export type RefreshResult = { mailboxes: ({ email: string; kept: number; gone: number; more: boolean } | { email: string; error: string })[] };
/** One refresh at a time per hub: a second ask while one runs gets the same answer. */
const running = new WeakMap<Hub, Promise<RefreshResult>>();

/**
 * Bring every linked iCloud mailbox's Inbox up to date: new mail of the last INBOX_DAYS kept, what left the Inbox gone.
 * `owner`: the Refresh button, which also tries a mailbox paused after a refused password once.
 */
export function refreshMail(hub: Hub, opts: { owner?: boolean } = {}, now: Date = new Date()): Promise<RefreshResult> {
  const busy = running.get(hub);
  if (busy) return busy;
  const run = exclusive(hub, async (): Promise<RefreshResult> => {
    const db = hub.mailDb;
    // Done mail is kept DONE_DAYS (Done view, Undo), then deleted from the hub; it stays in iCloud's Archive.
    wakeSnoozed(hub, now);
    if (db.prepare("DELETE FROM inbox WHERE state = 'done' AND done_at < ?").run(new Date(now.getTime() - DONE_DAYS * DAY_MS).toISOString()).changes) db.pragma("wal_checkpoint(TRUNCATE)");
    const out: RefreshResult = { mailboxes: [] };
    const save = db.prepare("INSERT INTO mailboxes (account, last_refresh, last_error, more) VALUES (?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET last_refresh = excluded.last_refresh, last_error = excluded.last_error, more = excluded.more");
    const since = new Date(now.getTime() - INBOX_DAYS * DAY_MS);
    const arrived: string[] = [];
    for (const [source, account] of INBOX_SOURCES.flatMap((src) => src.accounts(hub).map((a) => [src, a] as const))) {
      const email = account.slice(source.prefix.length);
      try {
        const missing = db.prepare("SELECT 1 FROM inbox WHERE account = ? AND id = ? AND refs IS NULL");
        const sentFrom = (db.prepare("SELECT sent_at FROM mailboxes WHERE account = ?").get(account) as { sent_at: string | null } | undefined)?.sent_at ?? null;
        // Old pins become flags first (once), or this listing's flags would unpin them.
        await flagOldPins(hub, account);
        const found = await source.list(hub, account, since, isKept(db, account), isKeptMessage(db, account), { ...opts, needsRefs: (id) => !!missing.get(account, id), sentFrom });
        const before = (db.prepare("SELECT last_refresh FROM mailboxes WHERE account = ?").get(account) as { last_refresh: string | null } | undefined)?.last_refresh ?? null;
        const r = keepInbox(db, account, found);
        for (const key of r.woken) unsnoozeMail(hub, key, {}, now);
        // New mail since the last refresh, never the first one (a mailbox's first 90 days).
        if (before) arrived.push(...r.fresh.filter((key) => { const at = (db.prepare("SELECT at FROM inbox WHERE key = ?").get(key) as { at: string } | undefined)?.at; return !!at && Date.parse(at) >= Date.parse(before) - NOTIFY_SLACK_MS; }));
        save.run(account, new Date().toISOString(), null, found.more ? 1 : 0);
        if (found.sentAt) db.prepare("UPDATE mailboxes SET sent_at = ? WHERE account = ?").run(found.sentAt, account);
        if (r.kept || r.gone || found.more) console.log(`[mail-inbox] ${mailboxLabel(hub, account)}: ${r.kept} new, ${r.gone} left the Inbox${found.more ? ", more next time" : ""}`);
        out.mailboxes.push({ email, kept: r.kept, gone: r.gone, more: found.more });
        // Blocked senders' mail: to Spam (the fenced MOVE), before any new-mail alert looks at it.
        const blockedNow = blockedKeys(db, blockedSenders(db), account);
        if (blockedNow.length) {
          const b = await moveNow(hub, blockedNow, "junk", null, now).catch((e) => { console.error(`[mail-inbox] ${mailboxLabel(hub, account)}: blocked ${errCode(e)}`); return null; });
          if (b?.moved.length) console.log(`[mail-inbox] ${mailboxLabel(hub, account)}: ${b.moved.length} from blocked senders moved to Spam`);
        }
        // The other folders: after the Inbox, and a folder that cannot be read does not stop the Inbox's refresh.
        if (source.listFolders) {
          try {
            const f = keepFolders(db, account, await source.listFolders(hub, account, since, isKeptInFolder(db, account)));
            if (f.kept || f.gone) console.log(`[mail-inbox] ${mailboxLabel(hub, account)}: folders ${f.kept} new, ${f.gone} gone`);
          } catch (e) { console.error(`[mail-inbox] ${mailboxLabel(hub, account)}: folders ${errCode(e)}`); }
        }
      } catch (e) {
        // A StoreError's message is the hub's own (a source never passes on the server's words); anything else is not shown.
        const error = e instanceof StoreError ? e.message : "The mailbox could not be refreshed. The hub's log has the error code.";
        // The time of the last refresh that worked stays: new mail is told from it, and mail that came while the
        // mailbox could not be reached is still new when it can be again.
        db.prepare("INSERT INTO mailboxes (account, last_refresh, last_error, more) VALUES (?, NULL, ?, 0) ON CONFLICT(account) DO UPDATE SET last_error = excluded.last_error, more = 0").run(account, error);
        console.error(`[mail-inbox] ${mailboxLabel(hub, account)}: ${errCode(e)}`);
        out.mailboxes.push({ email, error });
      }
    }
    try { notifyNewMail(hub, arrived, now); } catch (e) { console.error(`[mail-inbox] notify ${errCode(e)}`); }
    // Triage: a summary is kept TRIAGE_DAYS; then the new mail is triaged in the background.
    if (db.prepare("UPDATE inbox SET triage = NULL, triaged_at = NULL WHERE triaged_at < ?").run(new Date(now.getTime() - TRIAGE_DAYS * DAY_MS).toISOString()).changes) db.pragma("wal_checkpoint(TRUNCATE)");
    void triageNew(hub, now).catch((e) => console.error(`[mail-inbox] triage ${errCode(e)}`));
    // The new mail's web pictures, in the background (the Refresh button does not wait for them).
    void fetchMailImages(hub).catch((e) => console.error(`[mail-inbox] pictures: ${errCode(e)}`));
    return out;
  });
  running.set(hub, run);
  void run.finally(() => running.delete(hub)).catch(() => {});
  return run;
}

/** A minute after start, then every 15 minutes while the module is on: a refresh; a minute later while more is waiting. */
export function startMailInboxJob(hub: Hub): () => void {
  let soon: NodeJS.Timeout | undefined;
  const tick = () => {
    if (!hub.modules.on("mail_inbox")) return;
    refreshMail(hub).then((r) => {
      // More new mail than one refresh takes (the first one, often): the next batch a minute later.
      if (!r.mailboxes.some((m) => "more" in m && m.more)) return;
      clearTimeout(soon);
      soon = setTimeout(tick, 60_000);
      soon.unref?.();
    }).catch((e) => console.error(`[mail-inbox] ${errCode(e)}`));
  };
  const first = setTimeout(tick, 60_000);
  const every = setInterval(tick, 15 * 60_000);
  // Held bundles whose time has come: looked at every minute.
  const minute = setInterval(() => {
    if (!hub.modules.on("mail_inbox")) return;
    try { notifyDeliveries(hub); } catch (e) { console.error(`[mail-inbox] notify ${errCode(e)}`); }
  }, 60_000);
  first.unref?.();
  every.unref?.();
  minute.unref?.();
  return () => { clearTimeout(first); clearInterval(every); clearTimeout(soon); clearInterval(minute); };
}
