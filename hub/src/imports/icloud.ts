import { ImapFlow } from "imapflow";
import { nowIso } from "@everythingapp/shared";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { errCode } from "../logsafe.js";
import { BACKFILL_DAYS, MAIL_QUERY, OVERLAP_MS } from "./gmail.js";
import type { FetchedMail, MailRef, MailSource } from "./mail-sources.js";
import { bodyText, readingText } from "./mail-text.js";
import { cleanMailHtml, pictureData } from "../mail-html.js";
import { mailCards } from "../mail-cards.js";
import type { InboxListing, InboxMail, InboxSource, MailAddress, MoveRef } from "./inbox-source.js";
export type { InboxMail, MailAddress, MoveRef } from "./inbox-source.js";

/**
 * iCloud Mail, read-only, over IMAP. Apple has no sign-in for mail, so each mailbox is linked with an app-specific
 * password the owner makes at account.apple.com and enters once; it is kept only in connections.json (sealed) and never
 * shown, logged or sent anywhere but iCloud. The hub talks only to imap.mail.me.com:993 over TLS with normal certificate
 * checks; nothing a request, setting or the assistant sends can change that.
 *
 * Read-only for real: every folder is opened with EXAMINE, message parts are fetched with BODY.PEEK (nothing is marked
 * read), and nothing here stores, copies, appends, expunges or deletes. The Mail screen's two writes are fenced each in a
 * function of its own: moveICloud (Done and Undo: an IMAP MOVE of a kept message between the Inbox and the Archive folder)
 * and setSeenICloud (opening a mail or Mark unread: the `\Seen` flag added or removed, no other flag). Only text parts are fetched, capped,
 * and for the Mail screen the pictures a mail's HTML shows from inside it (`cid:`), never other attachments. For receipts, mail is read in memory and never stored, as for Gmail; the Mail screen's listing
 * (listInboxICloud) hands the Inbox's mail to mail-inbox.ts, which keeps its text while it is in the Inbox.
 */

const HOST = "imap.mail.me.com";
const PORT = 993;
/** The prefix that marks an iCloud mailbox in the `mail` table (mail-sources.ts). */
const PREFIX = "icloud:";
/** At most this much of each text part is read. */
export const PART_MAX = 256 * 1024;
/** At most this many text parts of one message are read (a text and an HTML version, and a few more). */
const PARTS_MAX = 4;
/** Folders whose special use says they are not received mail. */
const SKIP_USE = new Set(["\\Junk", "\\Trash", "\\Drafts", "\\Sent"]);
/** A link to the message when it carries no Message-ID: iCloud Mail on the web. */
const WEB_LINK = "https://www.icloud.com/mail/";

export interface ICloudAccount {
  email: string;
  /** The app-specific password, as Apple shows it (abcd-efgh-ijkl-mnop). Never leaves the hub but to iCloud. */
  password: string;
  linked_at: string;
  /** Mail up to this time has been listed; the next read starts a little before it. */
  listed_to?: string;
  /** The search it was listed with; another search lists the mailbox again. */
  query?: string;
  last_sync?: string;
  last_error?: string | null;
  /**
   * When iCloud last refused the password. The hub then stops signing in on its own (repeated refused sign-ins can get
   * an Apple Account locked) until the mailbox is linked again or the owner presses Read now, which tries once.
   */
  refused_at?: string | null;
  /** Whether its mail is read (Mail receipts). Absent is yes: accounts linked before calendars were. */
  mail?: boolean;
  /** Its calendars, when calendar sync uses this account (calendar-sync.ts). */
  calendar?: import("../calendar-sync.js").CalendarConf;
}

/** Said when iCloud refused a mailbox's password and the hub stopped signing in. */
export const REFUSED = "iCloud refused this mailbox's app-specific password (it was revoked, or the Apple Account changed). The hub stopped signing in so your account is not locked. Make a new app-specific password at account.apple.com and link the mailbox again, or press Read now (or Refresh in Mail) to try this one once more.";

/**
 * Gmail's search words, so both sources look for the same mail: every `subject:` word in MAIL_QUERY, and the two
 * words Gmail looks for anywhere in the mail, which IMAP looks for in the body.
 */
export const SUBJECT_WORDS = [...MAIL_QUERY.matchAll(/subject:(\w+)/g)].map((m) => m[1]);
export const BODY_WORDS = ["veterinary", "animal hospital"];
/** What a listing searched with, kept on the account: a change lists the mailbox again. */
const SEARCH_ID = JSON.stringify({ subject: SUBJECT_WORDS, body: BODY_WORDS });

// ---------------------------------------------------------------------------------------------------------------------
// The IMAP client. Only these calls are used; the type names exactly what the hub may ask of a server, and no call that
// changes a mailbox is in it. Tests swap in a fake with setImapFactory.

export interface ImapFolder { path: string; specialUse?: string; flags: Set<string> }
export interface ImapPart { part?: string; type: string; id?: string; size?: number; encoding?: string; disposition?: string; dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; childNodes?: ImapPart[] }
export interface ImapAddress { name?: string; address?: string }
export interface ImapMessage {
  internalDate?: Date | string;
  envelope?: { date?: Date | string; subject?: string; messageId?: string; inReplyTo?: string; from?: ImapAddress[]; replyTo?: ImapAddress[]; to?: ImapAddress[]; cc?: ImapAddress[] };
  bodyStructure?: ImapPart;
  /** Only the header lines asked for by name (`headers`), as the server sent them. */
  headers?: Buffer;
}
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  list(): Promise<ImapFolder[]>;
  mailboxOpen(path: string, options: { readOnly: true }): Promise<{ uidValidity: bigint }>;
  search(query: Record<string, unknown>, options: { uid: true }): Promise<number[] | false | undefined>;
  /** `headers` names header lines to fetch (with BODY.PEEK, like everything here): only the Mail screen asks for them. */
  fetchOne(uid: string, query: { envelope: true; bodyStructure: true; internalDate: true; headers?: string[] }, options: { uid: true }): Promise<ImapMessage | false>;
  download(uid: string, part: string, options: { uid: true; maxBytes: number }): Promise<{ content?: NodeJS.ReadableStream } | undefined>;
  /** Each message's flags (`FETCH FLAGS`, which reads and changes nothing): only the Mail screen asks, for read and unread. */
  fetch?(range: string, query: { uid: true; flags: true }, options: { uid: true }): AsyncIterable<{ uid: number; flags?: Set<string> }>;
}
export interface ImapLogin { user: string; pass: string }
/**
 * What moveICloud may ask of a server besides reading, and only it: open a folder read-write (SELECT) and MOVE
 * messages out of it. Never a STORE, COPY, APPEND, EXPUNGE or delete: those are not in the type.
 */
export interface ImapMover {
  capabilities: Map<string, unknown>;
  mailboxOpen(path: string, options: { readOnly: false }): Promise<{ uidValidity: bigint }>;
  /** imapflow's MOVE: `uidMap` gives each message's new UID in the destination (UIDPLUS, which iCloud has). */
  messageMove(uid: string, destination: string, options: { uid: true }): Promise<{ uidValidity?: bigint; uidMap?: Map<number, number> } | false>;
  /** STORE +FLAGS / -FLAGS of `\Seen` (read) or `\Flagged` (a pin) only: the type takes no other flag (setFlagICloud). */
  messageFlagsAdd(uid: string, flags: ["\\Seen"] | ["\\Flagged"], options: { uid: true }): Promise<boolean>;
  messageFlagsRemove(uid: string, flags: ["\\Seen"] | ["\\Flagged"], options: { uid: true }): Promise<boolean>;
}

const realClient = (login: ImapLogin): ImapClient => new ImapFlow({
  host: HOST, port: PORT, secure: true, auth: login,
  // imapflow's own logger would write the conversation with the server, addresses included.
  logger: false,
  connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
  disableAutoIdle: true,
}) as unknown as ImapClient;
let makeClient = realClient;

/** For tests: a fake IMAP client in place of iCloud. Null puts the real one back. */
export function setImapFactory(f: ((login: ImapLogin) => ImapClient) | null) {
  makeClient = f ?? realClient;
}

/** iCloud refused the address and password: told apart from a server out of reach, which is tried again later. */
export class ICloudRefused extends StoreError {
  constructor() { super(422, "iCloud did not accept this address and app-specific password. Check both, or make a new app-specific password at account.apple.com."); }
}

/** The hub's own words for a failure: never the server's, which can repeat the address or the password's owner. */
function failure(e: unknown): StoreError {
  if (e instanceof StoreError) return e;
  if ((e as { authenticationFailed?: boolean })?.authenticationFailed) return new ICloudRefused();
  return new StoreError(502, "iCloud Mail could not be reached from the hub, or stopped answering. Check the hub's internet connection and try again.");
}

/**
 * How long one job may take in all, connection included: the socket timeout ends only a silent connection, and a
 * server that keeps sending a little would hold the mail job without end. Tests shorten them.
 */
const DEADLINES = { check: 60_000, list: 10 * 60_000, read: 2 * 60_000 };
export function setICloudDeadlines(d: Partial<typeof DEADLINES> | null) {
  Object.assign(DEADLINES, d ?? { check: 60_000, list: 10 * 60_000, read: 2 * 60_000 });
}

/** One connection for one job, closed at the end whatever happens, and given up at its deadline. */
async function withClient<T>(login: ImapLogin, deadlineMs: number, job: (c: ImapClient) => Promise<T>): Promise<T> {
  const c = makeClient(login);
  let timer: NodeJS.Timeout | undefined;
  const run = (async () => { await c.connect(); return job(c); })();
  run.catch(() => {}); // after the deadline it ends on its own, as the connection is closed under it
  try {
    return await Promise.race([run, new Promise<never>((_, fail) => {
      timer = setTimeout(() => {
        try { c.close(); } catch { /* closed already */ }
        fail(new StoreError(502, "iCloud Mail stopped answering in time. The hub tries again later."));
      }, deadlineMs);
      timer.unref?.();
    })]);
  } catch (e) {
    throw failure(e);
  } finally {
    clearTimeout(timer);
    await c.logout().catch(() => { try { c.close(); } catch { /* closed already */ } });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Accounts

const accountName = (email: string) => `${PREFIX}${email}`;
const emailOf = (account: string) => account.slice(PREFIX.length);

function account(hub: Hub, email: string): ICloudAccount {
  const a = hub.connections.get().icloud?.find((x) => x.email === email);
  if (!a) throw new StoreError(404, "that iCloud mailbox is not linked");
  return a;
}

function saveAccount(hub: Hub, email: string, fields: Partial<ICloudAccount>) {
  hub.connections.update((c) => { const a = c.icloud?.find((x) => x.email === email); if (a) Object.assign(a, fields); });
}

/** An app-specific password as Apple shows it, or null when `v` is not one (an Apple ID password never is). */
export function appPassword(v: unknown): string | null {
  const letters = typeof v === "string" ? v.replace(/[\s-]/g, "").toLowerCase() : "";
  return /^[a-z]{16}$/.test(letters) ? letters.match(/.{4}/g)!.join("-") : null;
}

/** Link a mailbox: check the password with iCloud once, keep it, and start the first read. */
export async function linkICloud(hub: Hub, body: Record<string, unknown>, read: (account: string) => void = () => {}) {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new StoreError(422, "email is the iCloud Mail address");
  const password = appPassword(body.password);
  if (!password) throw new StoreError(422, "password is an app-specific password made at account.apple.com (16 letters, like abcd-efgh-ijkl-mnop), not your Apple ID password");
  await withClient({ user: email, pass: password }, DEADLINES.check, async () => {});
  hub.connections.update((c) => {
    const list = (c.icloud ??= []);
    const prev = list.find((a) => a.email === email);
    if (prev) Object.assign(prev, { password, last_error: null, refused_at: null, mail: true });
    else list.push({ email, password, linked_at: nowIso() });
  });
  read(accountName(email));
  return hub.connections.view().icloud;
}

/** Unlink a mailbox: its password and queue go; filed records stay. The password itself is revoked only at Apple. */
export function unlinkICloud(hub: Hub, email: string) {
  account(hub, email);
  hub.db.prepare("DELETE FROM mail WHERE account = ?").run(accountName(email));
  // Calendar sync may still use the account: then only its mail stops, and the password stays for the calendars.
  if (account(hub, email).calendar) {
    hub.connections.update((c) => { const a = c.icloud?.find((x) => x.email === email); if (a) a.mail = false; });
    return { ...hub.connections.view().icloud, message: "The hub stopped reading this mailbox. Its app-specific password stays on the hub because calendar sync uses it; stop calendar sync too to delete it." };
  }
  hub.connections.update((c) => { c.icloud = (c.icloud ?? []).filter((x) => x.email !== email); });
  return { ...hub.connections.view().icloud, message: "The mailbox is unlinked and its password deleted from the hub. To end the password itself, revoke it at account.apple.com, under Sign-In and Security, App-Specific Passwords." };
}

// ---------------------------------------------------------------------------------------------------------------------
// Listing and reading

/** The folders that hold received mail: every one but Junk, Trash, Drafts and Sent, and ones that cannot be opened. */
export function mailFolders(folders: ImapFolder[]): ImapFolder[] {
  return folders.filter((f) => !(f.specialUse && SKIP_USE.has(f.specialUse)) && !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"));
}

/** The server-side search: since a day, any of Gmail's subject words, or the vet words in the body. */
export function searchQuery(since: Date): Record<string, unknown> {
  return { since, or: [...SUBJECT_WORDS.map((w) => ({ subject: w })), ...BODY_WORDS.map((w) => ({ body: w }))] };
}

/** A message id: `<UIDVALIDITY>:<UID>:<folder>`, since a UID is unique only in one folder and one UIDVALIDITY. */
const messageId = (uidValidity: bigint | number | string, uid: number, folder: string) => `${uidValidity}:${uid}:${folder}`;
function parseId(id: string): { validity: string; uid: string; folder: string } | null {
  const m = /^(\d+):(\d+):([\s\S]+)$/.exec(id);
  return m ? { validity: m[1], uid: m[2], folder: m[3] } : null;
}

/** List a mailbox's likely mail since it was last listed (the first time, the last BACKFILL_DAYS) and queue what is new. */
export async function listICloud(hub: Hub, accountKey: string, now: Date = new Date(), opts: { owner?: boolean } = {}): Promise<{ listed: number; queued: number }> {
  const email = emailOf(accountKey);
  let a = account(hub, email);
  if (a.refused_at && !opts.owner) throw new StoreError(409, REFUSED);
  if (a.listed_to && a.query !== SEARCH_ID) {
    hub.db.prepare("DELETE FROM mail WHERE account = ? AND state = 'queued'").run(accountKey);
    saveAccount(hub, email, { listed_to: undefined });
    a = account(hub, email);
  }
  const from = a.listed_to ? new Date(Date.parse(a.listed_to) - OVERLAP_MS) : new Date(now.getTime() - BACKFILL_DAYS * 86400_000);
  const ids: string[] = [];
  try {
    await withClient({ user: a.email, pass: a.password }, DEADLINES.list, async (c) => {
      for (const f of mailFolders(await c.list())) {
        const box = await c.mailboxOpen(f.path, { readOnly: true });
        const uids = (await c.search(searchQuery(from), { uid: true })) || [];
        // Oldest first, so the filer (which takes the newest queued first) reads recent mail before old.
        for (const uid of [...uids].sort((x, y) => x - y)) ids.push(messageId(box.uidValidity, uid, f.path));
      }
    });
  } catch (e) {
    const f = failure(e);
    if (f instanceof ICloudRefused) saveAccount(hub, email, { last_sync: nowIso(), last_error: REFUSED, refused_at: nowIso() });
    else saveAccount(hub, email, { last_sync: nowIso(), last_error: f.message });
    throw f;
  }
  const insert = hub.db.prepare("INSERT OR IGNORE INTO mail (account, id, state) VALUES (?, ?, 'queued')");
  let queued = 0;
  hub.db.transaction(() => { for (const id of ids) queued += insert.run(accountKey, id).changes; }).immediate();
  saveAccount(hub, email, { listed_to: now.toISOString(), query: SEARCH_ID, last_sync: nowIso(), last_error: null, refused_at: null });
  return { listed: ids.length, queued };
}

/** The text parts of a message worth reading: text/plain and text/html, not attachments, at most PARTS_MAX. */
export function textParts(node: ImapPart | undefined): { part: string; html: boolean }[] {
  const out: { part: string; html: boolean }[] = [];
  const walk = (n: ImapPart | undefined) => {
    if (!n || out.length >= PARTS_MAX) return;
    if (n.childNodes?.length) { for (const c of n.childNodes) walk(c); return; }
    const type = n.type.toLowerCase();
    const named = n.dispositionParameters?.filename || n.parameters?.name;
    if ((type === "text/plain" || type === "text/html") && n.disposition?.toLowerCase() !== "attachment" && !named) {
      out.push({ part: n.part ?? "1", html: type === "text/html" });
    }
  };
  walk(node);
  return out;
}

async function readStream(s: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!s) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of s as AsyncIterable<Buffer | string>) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(b);
    size += b.length;
    if (size >= PART_MAX) break;
  }
  return Buffer.concat(chunks).subarray(0, PART_MAX).toString("utf8");
}

/** A message's text parts (BODY.PEEK, capped), split into plain and HTML in the order they came. */
async function downloadText(c: ImapClient, uid: string, msg: ImapMessage): Promise<{ plain: string[]; html: string[] }> {
  const plain: string[] = [];
  const html: string[] = [];
  for (const p of textParts(msg.bodyStructure)) {
    const d = await c.download(uid, p.part, { uid: true, maxBytes: PART_MAX });
    (p.html ? html : plain).push(await readStream(d?.content));
  }
  return { plain, html };
}

/** One queued message as text, or null when it is gone (its folder, its UIDVALIDITY or the message itself). */
export async function readICloud(hub: Hub, accountKey: string, id: string): Promise<FetchedMail | null> {
  const ref = parseId(id);
  if (!ref) return null;
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  return withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    let box: { uidValidity: bigint };
    try { box = await c.mailboxOpen(ref.folder, { readOnly: true }); }
    catch (e) {
      // The server said NO: the folder is gone or renamed. Anything else (a dropped connection) is not "gone".
      if ((e as { responseStatus?: string })?.responseStatus === "NO") return null;
      throw e;
    }
    if (String(box.uidValidity) !== ref.validity) return null;
    const msg = await c.fetchOne(ref.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
    if (!msg) return null;
    const { plain, html } = await downloadText(c, ref.uid, msg);
    const env = msg.envelope ?? {};
    const sender = env.from?.[0];
    const at = new Date(msg.internalDate ?? env.date ?? Date.now());
    return {
      at: Number.isNaN(at.getTime()) ? new Date() : at,
      from: sender ? (sender.name ? `${sender.name} <${sender.address ?? ""}>` : sender.address ?? "") : "",
      subject: env.subject ?? "",
      text: bodyText(plain, html),
      message_id: env.messageId,
    };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_sync: nowIso(), last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The Mail screen (mail-inbox.ts): the Inbox folder's mail. Read-only as above: EXAMINE, BODY.PEEK (headers too).

/** At most this many kept messages have their thread headers read per refresh (mail kept before threads). */
const REFS_MAX = 500;
/** At most this many sent messages are looked at per refresh (their headers); the rest come on the next. */
export const SENT_SCAN_MAX = 500;
/** At most this many new messages are fetched per mailbox per refresh, newest first; the rest come on the next. */
export const INBOX_MAX = 300;
/** How far back the Mail screen looks for mail it does not have yet (the first refresh brings in this much). */
export const INBOX_DAYS = 90;
/** At most this much of a message's text is kept (a long newsletter is cut; Show original has the rest). */
export const TEXT_MAX = 100_000;
/**
 * Header lines fetched by name: whether a system sent the mail (a list, a notice, a newsletter), which the Mail screen
 * sorts by. The envelope has the rest (From, Reply-To, Subject, Message-ID).
 */
const INBOX_HEADERS = ["list-unsubscribe", "list-id", "auto-submitted", "precedence", "authentication-results", "bimi-location", "references", ...ESP_HEADERS()];
/** The Message-IDs a message answers: its References, then In-Reply-To (at most 50). */
const answers = (msg: ImapMessage) => [...new Set([...messageIds(headerValue(msg.headers, "references")), ...messageIds(msg.envelope?.inReplyTo)])].slice(-50);
/**
 * Headers only bulk-mail services add: Feedback-Id (which large senders must send), and the sending services' own
 * (Mailgun, SendGrid, Amazon SES, Mailchimp, Postmark, SparkPost). A function so INBOX_HEADERS can use it above.
 */
function ESP_HEADERS() { return ["feedback-id", "x-mailgun-sid", "x-sg-eid", "x-ses-outgoing", "x-mc-user", "x-pm-message-id", "x-msys-api"]; }
/** Sender addresses systems use: no-reply@, notifications@, shipment-tracking@ and the like. */
const SYSTEM_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|alerts?|updates?|news(letter)?s?|info|marketing|mailer(-daemon)?|bounces?|account(s)?|support|billing|receipts?|orders?|shipment-tracking|auto-?confirm|digest)([._+-][^@]*)?@/i;

/**
 * Whether a system sent this mail rather than a person: it says it is a list or automatic (List-Unsubscribe, List-Id,
 * Auto-Submitted, Precedence bulk/list/junk), or it comes from a system's kind of address.
 */
export function isAutomated(headers: Buffer | undefined, fromAddress: string): boolean {
  if (headerValue(headers, "list-unsubscribe") || headerValue(headers, "list-id")) return true;
  const auto = headerValue(headers, "auto-submitted").toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(bulk|list|junk)\b/i.test(headerValue(headers, "precedence"))) return true;
  // Sent through a bulk-mail service (a shop's order notices, a newsletter).
  if (ESP_HEADERS().some((h) => headerValue(headers, h))) return true;
  return SYSTEM_SENDER.test(fromAddress);
}

/** The Inbox: the folder named INBOX (IMAP's own name for it, in any case), or none. */
export function inboxFolder(folders: ImapFolder[]): ImapFolder | null {
  return folders.find((f) => f.path.toUpperCase() === "INBOX" && !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent")) ?? null;
}

/** `<id@host>` tokens in a header (References, In-Reply-To), at most `max`, without their angle brackets. */
export function messageIds(v: string | undefined | null, max = 50): string[] {
  if (!v) return [];
  return [...v.slice(0, 64 * 1024).matchAll(/<([^<>\s]{1,250})>/g)].slice(0, max).map((m) => m[1]);
}

/** Every value of one header, in the order the server sent them (topmost first), folded lines unfolded. */
export function headerValues(raw: Buffer | undefined, name: string): string[] {
  if (!raw) return [];
  const text = raw.subarray(0, 64 * 1024).toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const want = `${name.toLowerCase()}:`;
  return text.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(want)).map((l) => l.slice(want.length).trim());
}

/**
 * A brand's verified logo, from iCloud's own verdict, or null. iCloud checks BIMI when mail arrives (the brand's DNS
 * record, its logo, and the mark certificate a certificate authority issues only to the owner of the trademark) and
 * writes the result at the top of the mail: `Authentication-Results: bimi.icloud.com; bimi=pass header.d=… policy.
 * authority=pass`, with `BIMI-Location: … l=<logo>`. A logo is a trust signal, so all of these must hold:
 * - iCloud's own BIMI verdict is the first `bimi.icloud.com` result (iCloud writes one on every mail, `none` or
 *   `skipped` included, above anything the sender wrote; a sender's forged one comes below it and is never read), and
 *   it says bimi=pass and policy.authority=pass (the certificate checked, not only a DNS record anyone can publish);
 * - iCloud's DMARC verdict (the From address is really that domain's) is pass for the From domain;
 * - the logo's domain is the From domain or a domain above it (mail.amazon.com under amazon.com);
 * - the logo is an https address.
 * Never a site's favicon: a lookalike domain can serve a bank's logo as its own.
 */
export function verifiedLogo(headers: Buffer | undefined, fromAddress: string): { domain: string; url: string } | null {
  const from = fromAddress.slice(fromAddress.lastIndexOf("@") + 1).toLowerCase();
  if (!from || !fromAddress.includes("@")) return null;
  const results = headerValues(headers, "authentication-results");
  const bimi = results.find((v) => /^bimi\.icloud\.com\s*;/i.test(v));
  const dmarc = results.find((v) => /^dmarc\.icloud\.com\s*;/i.test(v));
  if (!bimi || !dmarc) return null;
  if (!/;\s*bimi=pass\b/i.test(bimi) || !/\bpolicy\.authority=pass\b/i.test(bimi)) return null;
  if (!/;\s*dmarc=pass\b/i.test(dmarc) || (/\bheader\.from=([^\s;]+)/i.exec(dmarc)?.[1] ?? "").toLowerCase() !== from) return null;
  const d = (/\bheader\.d=([^\s;]+)/i.exec(bimi)?.[1] ?? "").toLowerCase();
  if (!d || (from !== d && !from.endsWith(`.${d}`))) return null;
  const url = /(?:^|[;\s])l=(https:\/\/[^\s;]{1,2000})/i.exec(headerValue(headers, "bimi-location"))?.[1];
  if (!url) return null;
  try { if (new URL(url).protocol !== "https:") return null; } catch { return null; }
  return { domain: d, url };
}

/** One header's value from header lines as the server sent them (folded lines unfolded), or "". */
export function headerValue(raw: Buffer | undefined, name: string): string {
  if (!raw) return "";
  const text = raw.subarray(0, 64 * 1024).toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const want = `${name.toLowerCase()}:`;
  const line = text.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(want));
  return line ? line.slice(want.length).trim() : "";
}

const mailAddress = (a: ImapAddress | undefined): MailAddress => ({ name: (a?.name ?? "").trim().slice(0, 200), address: (a?.address ?? "").trim().toLowerCase().slice(0, 254) });
const bareId = (v: string | undefined | null) => messageIds(v, 1)[0] ?? null;

/** What the Mail screen keeps of one fetched message. */
function inboxMail(id: string, msg: ImapMessage, text: string, shown: { html: string; remote: string[]; pictures?: number } | null = null): InboxMail {
  const env = msg.envelope ?? {};
  const from = mailAddress(env.from?.[0]);
  const replyTo = mailAddress(env.replyTo?.[0]).address;
  const at = new Date(msg.internalDate ?? env.date ?? Date.now());
  const listId = headerValue(msg.headers, "list-id").slice(0, 200);
  return {
    id,
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    message_id: bareId(env.messageId),
    from,
    // IMAP servers fill Reply-To with From when a mail has none, so only a different address is worth a warning.
    reply_to: replyTo && replyTo !== from.address ? replyTo : null,
    subject: (env.subject ?? "").slice(0, 500),
    text: text.slice(0, TEXT_MAX),
    automated: isAutomated(msg.headers, from.address),
    unsubscribe: !!headerValue(msg.headers, "list-unsubscribe"),
    list_id: listId || null,
    // HTML_MAX is for the markup: the pictures sent inside the mail, written into it, have their own limit.
    html: shown && shown.html.length - (shown.pictures ?? 0) <= HTML_MAX ? shown.html : null,
    remote: shown && shown.html.length - (shown.pictures ?? 0) <= HTML_MAX ? shown.remote : [],
    logo: verifiedLogo(msg.headers, from.address),
    refs: answers(msg),
    mine: false,
  };
}

/** At most this much cleaned HTML is kept per message (pictures not counted); a larger mail is shown as text. */
export const HTML_MAX = 1_000_000;
/** Pictures sent inside a mail: at most this many, each at most this big. */
const CID_MAX = 20;
const CID_BYTES = 2_000_000;

/** The pictures sent inside a message that its HTML shows (`cid:`), by Content-ID: image parts only, never attachments. */
export function cidParts(node: ImapPart | undefined, html: string): { part: string; cid: string }[] {
  const out: { part: string; cid: string }[] = [];
  // Once, not once per part: a message can have thousands of parts.
  const lower = html.toLowerCase();
  const walk = (n: ImapPart | undefined) => {
    if (!n || out.length >= CID_MAX) return;
    if (n.childNodes?.length) { for (const c of n.childNodes) walk(c); return; }
    const cid = (n.id ?? "").trim().replace(/^<|>$/g, "");
    if (!cid || !n.type.toLowerCase().startsWith("image/") || (n.size ?? 0) > CID_BYTES * 1.4) return;
    if (!lower.includes(`cid:${cid.toLowerCase()}`)) return;
    out.push({ part: n.part ?? "1", cid });
  };
  walk(node);
  return out;
}

async function readBytes(s: NodeJS.ReadableStream | undefined, max: number): Promise<Buffer | null> {
  if (!s) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of s as AsyncIterable<Buffer | string>) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > max) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/** A message's HTML cleaned for the Mail screen, with the pictures sent inside it (BODY.PEEK, capped) written in. */
async function shownHtml(c: ImapClient, uid: string, msg: ImapMessage, html: string[]): Promise<{ html: string; remote: string[]; pictures: number } | null> {
  const raw = html.join("\n");
  if (!raw.trim()) return null;
  const cids = new Map<string, string>();
  for (const p of cidParts(msg.bodyStructure, raw)) {
    const d = await c.download(uid, p.part, { uid: true, maxBytes: CID_BYTES });
    const bytes = await readBytes(d?.content, CID_BYTES);
    const data = bytes && pictureData(bytes);
    if (data) cids.set(p.cid, data);
  }
  // Mail is hostile input: a mail whose HTML the cleaner fails on is shown as text, and the refresh goes on.
  try { return cleanMailHtml(raw, cids); } catch (e) { console.error(`[mail-inbox] a mail's HTML could not be cleaned, so it shows as text: ${errCode(e)}`); return null; }
}

/**
 * The Mail screen's refresh for one mailbox, in one connection, read-only:
 * - `present`: the id of every message in the Inbox now (UIDs only, cheap), so the hub can tell what left it; null
 *   when the mailbox has no Inbox (nothing can be said to have left it then);
 * - `mails`: the Inbox's messages since `since` that `known` does not have, newest first, at most INBOX_MAX (`more`
 *   when there are others);
 * - `moved`: such a message whose Message-ID `knownMessage` has (it came back to the Inbox, or the folder's ids were
 *   renumbered), without its text being fetched again.
 * A refused password pauses the mailbox exactly as for receipts; `owner` (the Refresh button) tries it once.
 */
export async function listInboxICloud(hub: Hub, accountKey: string, since: Date, known: (id: string) => boolean, knownMessage: (messageId: string) => boolean, opts: { owner?: boolean; needsRefs?: (id: string) => boolean; sentFrom?: string | null } = {}): Promise<InboxListing> {
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at && !opts.owner) throw new StoreError(409, REFUSED);
  let present: string[] | null = null;
  let seen: string[] | null = null;
  let flagged: string[] | null = null;
  const mails: InboxMail[] = [];
  const moved: { id: string; message_id: string }[] = [];
  const refs: { id: string; refs: string[] }[] = [];
  let more = false;
  let sentAt: string | undefined;
  try {
    await withClient({ user: a.email, pass: a.password }, DEADLINES.list, async (c) => {
      const folders = await c.list();
      const f = inboxFolder(folders);
      if (!f) return;
      const box = await c.mailboxOpen(f.path, { readOnly: true });
      const id = (uid: number) => messageId(box.uidValidity, uid, f.path);
      const all = (await c.search({ all: true }, { uid: true })) || [];
      present = all.map(id);
      // Read or unread, as the mailbox has it (read in Apple Mail counts): FETCH FLAGS, which reads and changes nothing.
      // Flagged in Apple Mail is pinned here (since 2026-11-21): the same FETCH FLAGS.
      const read = new Set<number>();
      const pins = new Set<number>();
      if (c.fetch) {
        if (all.length) for await (const m of c.fetch("1:*", { uid: true, flags: true }, { uid: true })) {
          if (m.flags?.has("\\Seen")) read.add(m.uid);
          if (m.flags?.has("\\Flagged")) pins.add(m.uid);
        }
        seen = all.filter((uid) => read.has(uid)).map(id);
        flagged = all.filter((uid) => pins.has(uid)).map(id);
      }
      const fresh = ((await c.search({ since }, { uid: true })) || []).filter((uid) => !known(id(uid)));
      for (const uid of [...fresh].sort((x, y) => y - x)) {
        if (mails.length >= INBOX_MAX) { more = true; break; }
        const msg = await c.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true, headers: INBOX_HEADERS }, { uid: true });
        if (!msg) continue;
        const mid = bareId(msg.envelope?.messageId);
        if (mid && knownMessage(mid)) { moved.push({ id: id(uid), message_id: mid }); continue; }
        const { plain, html } = await downloadText(c, String(uid), msg);
        // The same for its text: one mail the hub cannot read must not keep the rest of the Inbox from arriving.
        let text: string;
        try { text = readingText(plain, html, "text", "html"); } catch (e) { text = plain.join("\n"); console.error(`[mail-inbox] a mail's text could not be read, so its text part is kept as it is: ${errCode(e)}`); }
        const m = inboxMail(id(uid), msg, text, await shownHtml(c, String(uid), msg, html));
        // Cards from the raw HTML: cleaning takes out the sender's schema.org data (a script) with every other script.
        m.cards = mailCards(html.join("\n"), m.subject, m.text, m.from, m.automated);
        m.attachments = attachmentParts(msg.bodyStructure);
        mails.push(m);
      }
      // Mail kept before threads: the Message-IDs it answers, headers only (at most REFS_MAX a refresh).
      for (const uid of all.filter((u) => known(id(u)) && opts.needsRefs?.(id(u))).slice(0, REFS_MAX)) {
        const msg = await c.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true, headers: ["references"] }, { uid: true });
        if (msg) refs.push({ id: id(uid), refs: answers(msg) });
      }
      // The owner's replies: from the folder iCloud marks Sent, read-only like the Inbox, only those answering mail the
      // hub keeps or lists now. Each is read by its headers first; the text only of those that belong.
      // Each sent mail is looked at once, when it is new: `sentFrom` is how far the folder was read last time
      // (`<UIDVALIDITY>:<UID>`), and only mail after it is looked at, oldest first, SENT_SCAN_MAX a refresh. Looking at
      // every sent mail of the last 90 days on every refresh cost one request each, every 15 minutes, for good.
      // While Inbox mail is still waiting for the next refresh, Sent waits too: a reply looked at before the mail
      // it answers is kept would be passed over.
      const sent = folders.find((x) => x.specialUse === "\\Sent" && !x.flags.has("\\Noselect"));
      if (!sent || more) return;
      const sbox = await c.mailboxOpen(sent.path, { readOnly: true });
      const sid = (uid: number) => messageId(sbox.uidValidity, uid, sent.path);
      const validity = String(sbox.uidValidity);
      const from = opts.sentFrom?.startsWith(`${validity}:`) ? Number(opts.sentFrom.slice(validity.length + 1)) || 0 : 0;
      const listed = new Set(mails.map((m) => m.message_id).filter((x): x is string => !!x));
      let mine = 0;
      let looked = 0;
      let at = from;
      for (const uid of ((await c.search({ since }, { uid: true })) || []).filter((u) => u > from && !known(sid(u))).sort((x, y) => x - y)) {
        if (looked >= SENT_SCAN_MAX || mine >= INBOX_MAX) { more = true; break; }
        looked++;
        at = uid;
        const msg = await c.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true, headers: ["references"] }, { uid: true });
        if (!msg) continue;
        const mid = bareId(msg.envelope?.messageId);
        const to = answers(msg);
        if ((mid && knownMessage(mid)) || !to.some((r) => listed.has(r) || knownMessage(r))) continue;
        const { plain, html } = await downloadText(c, String(uid), msg);
        let text: string;
        try { text = readingText(plain, html, "text", "html"); } catch (e) { text = plain.join("\n"); console.error(`[mail-inbox] a sent mail's text could not be read, so its text part is kept as it is: ${errCode(e)}`); }
        const m = inboxMail(sid(uid), msg, text, await shownHtml(c, String(uid), msg, html));
        m.mine = true;
        m.automated = false;
        // The owner's own reply quotes the mail it answers, web pictures and all. Fetching those again would tell
        // that mail's sender the owner answered (a second fetch, only after a reply): none is fetched for sent mail.
        m.remote = [];
        mails.push(m);
        mine++;
      }
      sentAt = `${validity}:${at}`;
    });
  } catch (e) {
    const f = failure(e);
    if (f instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw f;
  }
  if (a.refused_at) saveAccount(hub, email, { last_error: null, refused_at: null });
  return { present, seen, flagged, mails, moved, more, refs, ...(sentAt ? { sentAt } : {}) };
}

/** Show original: one message's whole text, fetched now and never kept; null when it is gone from the mailbox. */
export async function originalICloud(hub: Hub, accountKey: string, id: string): Promise<{ at: Date; from: MailAddress; reply_to: string | null; subject: string; text: string } | null> {
  const ref = parseId(id);
  if (!ref) return null;
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  return withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    let box: { uidValidity: bigint };
    try { box = await c.mailboxOpen(ref.folder, { readOnly: true }); }
    catch (e) { if ((e as { responseStatus?: string })?.responseStatus === "NO") return null; throw e; }
    if (String(box.uidValidity) !== ref.validity) return null;
    const msg = await c.fetchOne(ref.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
    if (!msg) return null;
    const { plain, html } = await downloadText(c, ref.uid, msg);
    const m = inboxMail(id, msg, readingText(plain, html));
    m.text = readingText(plain, html);
    return { at: m.at, from: m.from, reply_to: m.reply_to, subject: m.subject, text: m.text };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Attachments (since 2026-11-21): listed from the message's structure, read only when the owner opens or asks for one

/** One attachment as the Mail screen lists it: the part's number in the message, its name, its type, its size in bytes. */
export interface MailAttachment { part: string; name: string; type: string; size: number }
/** At most this many listed; a preview at most PREVIEW_BYTES (PREVIEWS_MAX a mail); a download at most FILE_BYTES. */
export const ATTACH_MAX = 30;
export const PREVIEW_BYTES = 5_000_000;
export const PREVIEWS_MAX = 10;
export const FILE_BYTES = 25_000_000;

/** A file name as the screen may show it and a browser may save it: one line, no folder in it, at most 120 characters. */
export function attachmentName(v: string | undefined, part: string): string {
  const s = (v ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return (s || `attachment-${part}`).slice(0, 120);
}

/**
 * A message's attachments, from its structure alone (nothing downloaded): every leaf part that is marked as an
 * attachment or has a file name, or is not text; never its text parts, and never a picture shown inside the mail (an
 * image with a Content-ID that is not marked as an attachment). The size is the part's own (base64 is a third bigger
 * than the file).
 */
export function attachmentParts(node: ImapPart | undefined): MailAttachment[] {
  const out: MailAttachment[] = [];
  const walk = (n: ImapPart | undefined) => {
    if (!n || out.length >= ATTACH_MAX) return;
    if (n.childNodes?.length) { for (const c of n.childNodes) walk(c); return; }
    const type = (n.type ?? "").toLowerCase();
    const disposition = (n.disposition ?? "").toLowerCase();
    const named = n.dispositionParameters?.filename ?? n.parameters?.name;
    const isText = type === "text/plain" || type === "text/html";
    if (disposition !== "attachment" && (isText && !named)) return;
    if (disposition !== "attachment" && type.startsWith("image/") && n.id) return;
    if (!named && disposition !== "attachment" && (isText || type.startsWith("multipart/"))) return;
    const part = n.part ?? "1";
    const size = Math.max(0, Math.round((n.size ?? 0) * ((n.encoding ?? "").toLowerCase() === "base64" ? 0.75 : 1)));
    out.push({ part, name: attachmentName(named, part), type: /^[a-z0-9.+-]{1,60}\/[a-z0-9.+-]{1,60}$/.test(type) ? type : "application/octet-stream", size });
  };
  walk(node);
  return out;
}

/**
 * A kept message, opened read-only (EXAMINE) in its folder for reading its attachments: the folder must be one iCloud
 * lists (the Inbox, Archive or a shown folder), not reset since (UIDVALIDITY), and the message still the one the hub
 * kept (its Message-ID read again). Null when it is not.
 */
async function openKept(c: ImapClient, ref: MoveRef): Promise<{ uid: string; msg: ImapMessage } | null> {
  const at = parseId(ref.id);
  if (!at || !ref.message_id) return null;
  const folders = await c.list();
  const allowed = new Set([inboxFolder(folders)?.path, folders.find((f) => f.specialUse === "\\Archive")?.path, ...shownFolders(folders).map((f) => f.path)].filter(Boolean));
  if (!allowed.has(at.folder)) return null;
  const box = await c.mailboxOpen(at.folder, { readOnly: true });
  if (String(box.uidValidity) !== at.validity) return null;
  const msg = await c.fetchOne(at.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
  if (!msg || bareId(msg.envelope?.messageId) !== ref.message_id) return null;
  return { uid: at.uid, msg };
}

/**
 * A kept message's attachments now, with a preview of each picture (JPEG, PNG, GIF or WebP, at most PREVIEW_BYTES,
 * PREVIEWS_MAX of them; its bytes must be a picture, whatever the mail calls it): read with BODY.PEEK, kept in memory
 * only. Null when the message is not there any more.
 */
export async function attachmentsICloud(hub: Hub, accountKey: string, ref: MoveRef): Promise<(MailAttachment & { preview?: string })[] | null> {
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  return withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    const kept = await openKept(c, ref);
    if (!kept) return null;
    const list: (MailAttachment & { preview?: string })[] = attachmentParts(kept.msg.bodyStructure);
    let previews = 0;
    for (const x of list) {
      if (previews >= PREVIEWS_MAX || !/^image\/(jpeg|png|gif|webp)$/.test(x.type) || x.size > PREVIEW_BYTES) continue;
      const d = await c.download(kept.uid, x.part, { uid: true, maxBytes: PREVIEW_BYTES });
      const bytes = await readBytes(d?.content, PREVIEW_BYTES);
      const data = bytes && pictureData(bytes);
      if (data) { x.preview = data; previews++; }
    }
    return list;
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
}

/** A kept message's To and Cc as the mailbox has them now (Reply all), read-only and checked again; null when it is gone. */
export async function recipientsICloud(hub: Hub, accountKey: string, ref: MoveRef): Promise<{ to: MailAddress[]; cc: MailAddress[] } | null> {
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  return withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    const kept = await openKept(c, ref);
    if (!kept) return null;
    const env = kept.msg.envelope ?? {};
    return { to: (env.to ?? []).slice(0, 50).map(mailAddress), cc: (env.cc ?? []).slice(0, 50).map(mailAddress) };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
}

/**
 * One attachment's bytes, for a download the owner asked for: only a part the message's own structure lists as an
 * attachment, at most FILE_BYTES, read with BODY.PEEK, never kept. Null when the message or the part is not there.
 */
export async function attachmentICloud(hub: Hub, accountKey: string, ref: MoveRef, part: string): Promise<{ name: string; bytes: Buffer } | null> {
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  return withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    const kept = await openKept(c, ref);
    if (!kept) return null;
    const x = attachmentParts(kept.msg.bodyStructure).find((y) => y.part === part);
    if (!x) return null;
    if (x.size > FILE_BYTES) throw new StoreError(413, "This attachment is too big to download here (more than 25 MB). Open the mail in Apple Mail for it.");
    const d = await c.download(kept.uid, x.part, { uid: true, maxBytes: FILE_BYTES });
    const bytes = await readBytes(d?.content, FILE_BYTES);
    if (!bytes) throw new StoreError(413, "This attachment is too big to download here (more than 25 MB). Open the mail in Apple Mail for it.");
    return { name: x.name, bytes };
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The Mail screen's other folders (since 2026-11-20): Drafts, Sent, Junk, Trash and the owner's own, read-only

/** A folder's part on the Mail screen, by the mark iCloud gives it (in any language); `own` for the owner's folders. */
export type FolderRole = "drafts" | "sent" | "junk" | "trash" | "own";
const ROLES: Record<string, FolderRole> = { "\\Drafts": "drafts", "\\Sent": "sent", "\\Junk": "junk", "\\Trash": "trash" };
/** At most this many folders, and this many new messages of one folder a refresh. */
export const FOLDERS_MAX = 30;
export const FOLDER_NEW_MAX = 50;
/** One folder of one refresh: what is in it since the time asked, what of that is read, and its new mail. */
export interface FolderListing { path: string; role: FolderRole; present: string[]; seen: string[]; mails: (InboxMail & { to: MailAddress[] })[]; more: boolean }

/** The folders the Mail screen shows besides the Inbox: not the Inbox, not Archive (Done shows it), not iCloud's virtual ones. */
export function shownFolders(folders: ImapFolder[]): { path: string; role: FolderRole }[] {
  return folders
    .filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent") && f.path.toUpperCase() !== "INBOX" && !["\\Archive", "\\All", "\\Flagged", "\\Important"].includes(f.specialUse ?? ""))
    .map((f) => ({ path: f.path, role: ROLES[f.specialUse ?? ""] ?? "own" }))
    .slice(0, FOLDERS_MAX);
}

/**
 * The Mail screen's refresh of a mailbox's other folders, in one connection, read-only like the Inbox (EXAMINE,
 * BODY.PEEK: nothing marked read): each folder's messages since `since`, their read flags, and the new ones' text and
 * HTML (FOLDER_NEW_MAX a folder, newest first). Their web pictures are never fetched: Sent and Drafts are the owner's
 * own (fetching them again tells the people they wrote to), and Junk's would tell a spammer the address is read.
 */
export async function listFoldersICloud(hub: Hub, accountKey: string, since: Date, known: (id: string) => boolean): Promise<FolderListing[]> {
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  const out: FolderListing[] = [];
  await withClient({ user: a.email, pass: a.password }, DEADLINES.list, async (c) => {
    for (const f of shownFolders(await c.list())) {
      const box = await c.mailboxOpen(f.path, { readOnly: true });
      const id = (uid: number) => messageId(box.uidValidity, uid, f.path);
      const uids = ((await c.search({ since }, { uid: true })) || []);
      const here = new Set(uids);
      const read: number[] = [];
      if (c.fetch && uids.length) for await (const m of c.fetch("1:*", { uid: true, flags: true }, { uid: true })) if (here.has(m.uid) && m.flags?.has("\\Seen")) read.push(m.uid);
      const fresh = uids.filter((u) => !known(id(u))).sort((x, y) => y - x);
      const mails: FolderListing["mails"] = [];
      for (const uid of fresh.slice(0, FOLDER_NEW_MAX)) {
        const msg = await c.fetchOne(String(uid), { envelope: true, bodyStructure: true, internalDate: true, headers: INBOX_HEADERS }, { uid: true });
        if (!msg) continue;
        const { plain, html } = await downloadText(c, String(uid), msg);
        let text: string;
        try { text = readingText(plain, html, "text", "html"); } catch (e) { text = plain.join("\n"); console.error(`[mail-inbox] a mail's text could not be read, so its text part is kept as it is: ${errCode(e)}`); }
        const m = inboxMail(id(uid), msg, text, await shownHtml(c, String(uid), msg, html));
        m.remote = [];
        mails.push({ ...m, attachments: attachmentParts(msg.bodyStructure), to: (msg.envelope?.to ?? []).slice(0, 20).map(mailAddress).filter((x) => x.address) });
      }
      out.push({ path: f.path, role: f.role, present: uids.map(id), seen: read.map(id), mails, more: fresh.length > FOLDER_NEW_MAX });
    }
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
  return out;
}

/**
 * Where Delete, Spam, Not spam and Move to may put mail: the Inbox, Trash, Junk, or one of the owner's own folders (its
 * path, as the hub kept it). Never Drafts, Sent or Archive (Done moves there), and never a path a request made up: the
 * folder must be one iCloud lists now.
 */
export type MoveDest = { role: "inbox" | "trash" | "junk" } | { path: string };

/**
 * Move kept messages (from the Inbox, Archive or any shown folder) to `dest`, in one connection: the same fence as
 * moveICloud. Only folders iCloud lists now take part; each message's folder must not have been reset (UIDVALIDITY) and
 * its Message-ID is read again (BODY.PEEK) and compared; only MOVE, never a copy, a delete flag or an expunge. The answer
 * has each message's new id, or null when it was not moved.
 */
export async function moveToICloud(hub: Hub, accountKey: string, refs: MoveRef[], dest: MoveDest): Promise<Map<string, string | null>> {
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  const out = new Map<string, string | null>(refs.map((r) => [r.id, null]));
  await withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    const w = c as unknown as ImapClient & ImapMover;
    if (typeof w.messageMove !== "function" || !w.capabilities?.has("MOVE")) throw new StoreError(502, "iCloud did not offer to move mail (IMAP MOVE), so nothing was moved.");
    const folders = await c.list();
    const inbox = inboxFolder(folders);
    const archive = folders.find((f) => f.specialUse === "\\Archive" && !f.flags.has("\\Noselect")) ?? null;
    const shown = shownFolders(folders);
    const to = "path" in dest
      ? shown.find((f) => f.path === dest.path && f.role === "own")?.path
      : dest.role === "inbox" ? inbox?.path : shown.find((f) => f.role === dest.role)?.path;
    if (!to) throw new StoreError(409, "That folder is not in this mailbox in iCloud (it was renamed or deleted). Refresh and try again.");
    const sources = new Set([inbox?.path, archive?.path, ...shown.map((f) => f.path)].filter((p): p is string => !!p && p !== to));
    const mine = refs.map((r) => ({ r, ref: parseId(r.id) })).filter((x) => !!x.ref && sources.has(x.ref.folder) && !!x.r.message_id);
    for (const folder of new Set(mine.map((x) => x.ref!.folder))) {
      const box = await w.mailboxOpen(folder, { readOnly: false });
      for (const { r, ref } of mine.filter((x) => x.ref!.folder === folder)) {
        if (String(box.uidValidity) !== ref!.validity) continue;
        const msg = await c.fetchOne(ref!.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
        if (!msg || bareId(msg.envelope?.messageId) !== r.message_id) continue;
        const moved = await w.messageMove(ref!.uid, to, { uid: true });
        if (!moved) continue;
        const uid = moved.uidMap?.get(Number(ref!.uid));
        out.set(r.id, uid && moved.uidValidity !== undefined ? messageId(moved.uidValidity, uid, to) : `moved:${r.id}`);
      }
    }
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Mail screen's one write: Done (Inbox to Archive) and its Undo (Archive to Inbox)


/**
 * Move kept messages between the Inbox and the Archive folder, in one connection. The fence around the hub's only
 * write to a mailbox:
 * 1. only the Inbox (IMAP's INBOX) and the folder iCloud marks `\Archive` take part: Done moves from the first to the
 *    second, Undo back; a message whose id names another folder is not touched;
 * 2. the folder must not have been reset since (its UIDVALIDITY is the id's);
 * 3. the message at that UID must still be the one the hub kept: its Message-ID is read again (BODY.PEEK) and compared,
 *    and a message without one is not moved;
 * 4. only MOVE, and only when the server offers it: without it a client copies, marks deleted and expunges, which the
 *    hub never does.
 * The answer has each message's new id (in the destination), or null when it was not moved.
 */
export async function moveICloud(hub: Hub, accountKey: string, refs: MoveRef[], to: "archive" | "inbox"): Promise<Map<string, string | null>> {
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  const out = new Map<string, string | null>(refs.map((r) => [r.id, null]));
  await withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    const w = c as unknown as ImapClient & ImapMover;
    if (typeof w.messageMove !== "function" || !w.capabilities?.has("MOVE")) throw new StoreError(502, "iCloud did not offer to move mail (IMAP MOVE), so nothing was moved.");
    const folders = await c.list();
    const inbox = inboxFolder(folders);
    const archive = folders.find((f) => f.specialUse === "\\Archive" && !f.flags.has("\\Noselect")) ?? null;
    if (!inbox || !archive) throw new StoreError(409, "This mailbox has no Archive folder in iCloud, so Done cannot move mail there.");
    const [from, dest] = to === "archive" ? [inbox, archive] : [archive, inbox];
    const mine = refs.map((r) => ({ r, ref: parseId(r.id) })).filter((x) => x.ref?.folder === from.path && !!x.r.message_id);
    if (!mine.length) return;
    const box = await w.mailboxOpen(from.path, { readOnly: false });
    for (const { r, ref } of mine) {
      if (String(box.uidValidity) !== ref!.validity) continue;
      const msg = await c.fetchOne(ref!.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
      if (!msg || bareId(msg.envelope?.messageId) !== r.message_id) continue;
      const moved = await w.messageMove(ref!.uid, dest.path, { uid: true });
      if (!moved) continue;
      const uid = moved.uidMap?.get(Number(ref!.uid));
      out.set(r.id, uid && moved.uidValidity !== undefined ? messageId(moved.uidValidity, uid, dest.path) : `moved:${r.id}`);
    }
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
  return out;
}

/**
 * Mark a kept message read or unread in iCloud (opening it on the Mail screen, or Mark unread). The fence around the
 * Mail screen's second write: only a message in the Inbox or the `\Archive` folder, the folder not reset since (its
 * UIDVALIDITY), the message still the one the hub kept (its Message-ID read again), and only the `\Seen` flag, added or
 * removed. False when it was not changed.
 */
export async function setSeenICloud(hub: Hub, accountKey: string, refs: MoveRef[], seen: boolean): Promise<boolean[]> {
  return setFlagICloud(hub, accountKey, refs, "\\Seen", seen);
}

/**
 * Pin or unpin as Apple Mail's flag (since 2026-11-21): `\Flagged` added or removed, fenced exactly as the read flag
 * (setFlagICloud): only a kept message in the Inbox or Archive, its UIDVALIDITY and Message-ID checked again.
 */
export async function setFlaggedICloud(hub: Hub, accountKey: string, refs: MoveRef[], flagged: boolean): Promise<boolean[]> {
  return setFlagICloud(hub, accountKey, refs, "\\Flagged", flagged);
}

/** Add or remove one flag, `\Seen` or `\Flagged` and no other, on kept messages in the Inbox or Archive (setSeenICloud's fence). */
async function setFlagICloud(hub: Hub, accountKey: string, refs: MoveRef[], flag: "\\Seen" | "\\Flagged", on: boolean): Promise<boolean[]> {
  const out = refs.map(() => false);
  const todo = refs.map((ref, i) => ({ i, ref, at: parseId(ref.id) })).filter((x) => x.at && x.ref.message_id);
  if (!todo.length) return out;
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  // One sign-in for all of them (opening a thread of 25 unread mails used to make 25), a folder at a time.
  return withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    const w = c as unknown as ImapClient & ImapMover;
    const folders = await c.list();
    const allowed = [inboxFolder(folders)?.path, folders.find((f) => f.specialUse === "\\Archive")?.path].filter(Boolean);
    for (const folder of [...new Set(todo.map((x) => x.at!.folder))]) {
      if (!allowed.includes(folder)) continue;
      const box = await w.mailboxOpen(folder, { readOnly: false });
      for (const x of todo.filter((y) => y.at!.folder === folder)) {
        if (String(box.uidValidity) !== x.at!.validity) continue;
        const msg = await c.fetchOne(x.at!.uid, { envelope: true, bodyStructure: true, internalDate: true }, { uid: true });
        if (!msg || bareId(msg.envelope?.messageId) !== x.ref.message_id) continue;
        out[x.i] = await (on ? w.messageFlagsAdd(x.at!.uid, [flag], { uid: true }) : w.messageFlagsRemove(x.at!.uid, [flag], { uid: true }));
      }
    }
    return out;
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
}

/**
 * What saveDraftICloud may ask of a server, and only it: APPEND one message to a folder, flagged `\Draft` and `\Seen`
 * (a draft is the owner's own, not new mail). The type takes no other flag, and nothing here opens, changes or deletes
 * a message that is there.
 */
export interface ImapDrafter {
  append(path: string, content: Buffer, flags: ["\\Draft", "\\Seen"]): Promise<{ uid?: number } | false>;
}
/** A draft is at most this big (the text is capped at 50,000 characters; base64 and headers add to it). */
export const DRAFT_BYTES = 400_000;

/**
 * Save a draft (mail-compose.ts built it) to the folder iCloud marks `\Drafts`: the Mail screen's third write, and the
 * only one that adds a message. Only that folder, only APPEND; the owner sends it from Apple Mail, and nothing here
 * sends mail.
 */
export async function saveDraftICloud(hub: Hub, accountKey: string, raw: Buffer): Promise<void> {
  if (raw.length > DRAFT_BYTES) throw new StoreError(413, "the draft is too big to save");
  const email = emailOf(accountKey);
  const a = account(hub, email);
  if (a.refused_at) throw new StoreError(409, REFUSED);
  await withClient({ user: a.email, pass: a.password }, DEADLINES.read, async (c) => {
    const w = c as unknown as ImapClient & ImapDrafter;
    if (typeof w.append !== "function") throw new StoreError(502, "iCloud did not offer to save a draft, so nothing was saved.");
    const drafts = (await c.list()).find((f) => f.specialUse === "\\Drafts" && !f.flags.has("\\Noselect"));
    if (!drafts) throw new StoreError(409, "This mailbox has no Drafts folder in iCloud, so the draft was not saved.");
    if (!(await w.append(drafts.path, raw, ["\\Draft", "\\Seen"]))) throw new StoreError(502, "iCloud did not take the draft.");
  }).catch((e) => {
    if (e instanceof ICloudRefused) saveAccount(hub, email, { last_error: REFUSED, refused_at: nowIso() });
    throw e;
  });
}

/** Opens the message in Apple Mail (Mac, iPhone, iPad) by its Message-ID; iCloud Mail on the web when it has none. */
export function icloudLink(ref: MailRef): string {
  const mid = ref.message_id?.trim().replace(/^<|>$/g, "");
  return mid ? `message://${encodeURIComponent(`<${mid}>`)}` : WEB_LINK;
}

/** iCloud Mail as a mail source. */
export const icloudSource: MailSource = {
  kind: "icloud",
  accounts: (hub) => (hub.connections.get().icloud ?? []).filter((a) => a.mail !== false).map((a) => accountName(a.email)),
  list: (hub, accountKey, opts) => listICloud(hub, accountKey, new Date(), opts),
  read: (hub, accountKey, id) => readICloud(hub, accountKey, id),
  link: icloudLink,
  isOwnLink: (url) => url.startsWith("message://") || url === WEB_LINK,
};

/** The Mail screen's iCloud source (imports/inbox-source.ts): its Inbox listing, its move (Inbox to Archive and back) and read or unread. */
export const icloudInbox: InboxSource = {
  prefix: PREFIX,
  accounts: (hub) => icloudSource.accounts(hub),
  list: (hub, account, since, known, knownMessage, opts) => listInboxICloud(hub, account, since, known, knownMessage, opts),
  move: (hub, account, refs, to) => moveICloud(hub, account, refs, to),
  setSeen: (hub, account, refs, seen) => setSeenICloud(hub, account, refs, seen),
  setFlagged: (hub, account, refs, flagged) => setFlaggedICloud(hub, account, refs, flagged),
  saveDraft: (hub, account, raw) => saveDraftICloud(hub, account, raw),
  listFolders: (hub, account, since, known) => listFoldersICloud(hub, account, since, known),
  moveTo: (hub, account, refs, dest) => moveToICloud(hub, account, refs, dest),
  attachments: (hub, account, ref) => attachmentsICloud(hub, account, ref),
  attachment: (hub, account, ref, part) => attachmentICloud(hub, account, ref, part),
  recipients: (hub, account, ref) => recipientsICloud(hub, account, ref),
};
