import crypto from "node:crypto";
import type { MailAddress } from "./imports/inbox-source.js";
import { StoreError } from "./store.js";

/**
 * Writing mail from the Mail screen (CONTRACT.md, Mail): a draft, saved to the mailbox's Drafts folder, which the owner
 * sends from their mail app. Nothing here sends mail. What this file guarantees, whatever a request or a kept mail says:
 * - the recipients are addresses the owner typed, or for a reply the sender's From address (never its Reply-To, which
 *   a phishing mail sets), each checked as one plain address;
 * - every header is one line (no CR, LF or control character can start another header) and non-ASCII is encoded;
 * - the owner's text goes in exactly as typed, as the message's only part (UTF-8, base64), with no HTML and no link
 *   added.
 */

export const TO_MAX = 20;
export const SUBJECT_MAX = 200;
export const DRAFT_TEXT_MAX = 50_000;
/** At most this many Message-IDs carried in References (the newest). */
const REFS_KEEP = 10;

/** One plain address: no name, no angle brackets, no comment, no list. */
const ADDRESS = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.[a-z]{2,63}$/i;
export const isAddress = (s: string) => s.length <= 254 && ADDRESS.test(s);
/** A Message-ID as kept (without angle brackets): one token. */
const MESSAGE_ID = /^[^\s<>]{1,250}$/;

/** One line of plain text: control characters (CR and LF among them) become spaces. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

/** A header value in RFC 2047 encoded words when it is not plain ASCII, each at most 75 characters. */
export function encodeWords(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const ch of Array.from(s)) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join(" ");
}

/** `"Name" <address>`, or the address alone. */
function mailbox(a: MailAddress): string {
  const name = oneLine(a.name).replace(/["\\]/g, "");
  if (!name) return a.address;
  return /^[\x20-\x7e]*$/.test(name) ? `"${name}" <${a.address}>` : `${encodeWords(name)} <${a.address}>`;
}

export interface Draft {
  from: MailAddress;
  to: string[];
  subject: string;
  text: string;
  /** A reply: the Message-ID it answers, and the thread's (References). */
  in_reply_to?: string;
  references?: string[];
}

/** The draft as an RFC 5322 message (CRLF line ends), with a new Message-ID at the sender's domain. */
export function buildMessage(d: Draft, now = new Date()): { raw: Buffer; message_id: string } {
  const domain = d.from.address.split("@")[1] ?? "localhost";
  const message_id = `${crypto.randomBytes(12).toString("hex")}@${domain}`;
  const headers = [
    `From: ${mailbox(d.from)}`,
    `To: ${d.to.join(", ")}`,
    `Subject: ${encodeWords(oneLine(d.subject))}`,
    `Date: ${now.toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: <${message_id}>`,
    ...(d.in_reply_to ? [`In-Reply-To: <${d.in_reply_to}>`] : []),
    ...(d.references?.length ? [`References: ${d.references.map((r) => `<${r}>`).join(" ")}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(d.text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n")).toString("base64").replace(/.{76}/g, "$&\r\n");
  return { raw: Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`), message_id };
}

/** The owner's text, checked: not empty, at most DRAFT_TEXT_MAX characters, kept as typed. */
export function checkedText(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new StoreError(422, "text is what to write, and cannot be empty");
  if (v.length > DRAFT_TEXT_MAX) throw new StoreError(422, `text is at most ${DRAFT_TEXT_MAX} characters`);
  return v;
}

/** A new mail's recipients and subject from a request: 1 to TO_MAX plain addresses, a subject of at most SUBJECT_MAX. */
export function checkedNew(body: Record<string, unknown>): { to: string[]; subject: string } {
  const to = Array.isArray(body.to) ? body.to : typeof body.to === "string" ? body.to.split(/[,;\s]+/) : [];
  const list = [...new Set(to.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (!list.length || list.length > TO_MAX) throw new StoreError(422, `to is 1 to ${TO_MAX} addresses`);
  const bad = list.find((x) => !isAddress(x));
  if (bad) throw new StoreError(422, `"${bad.slice(0, 60)}" is not an email address`);
  const subject = typeof body.subject === "string" ? oneLine(body.subject) : "";
  if (subject.length > SUBJECT_MAX) throw new StoreError(422, `subject is at most ${SUBJECT_MAX} characters`);
  return { to: list, subject };
}

/**
 * A reply's fields, from the kept mail it answers, never from the request: to its From address, "Re:" and its
 * subject, In-Reply-To its Message-ID, References its thread's (the newest REFS_KEEP).
 */
export function replyFields(m: { from_address: string; subject: string; message_id: string | null; refs: string[] }): { to: string[]; subject: string; in_reply_to?: string; references?: string[] } {
  const to = m.from_address.trim().toLowerCase();
  if (!isAddress(to)) throw new StoreError(422, "this mail's sender has no address a reply can go to");
  const subject = oneLine(m.subject).slice(0, SUBJECT_MAX);
  const mid = m.message_id && MESSAGE_ID.test(m.message_id) ? m.message_id : undefined;
  const refs = [...m.refs.filter((r) => MESSAGE_ID.test(r)), ...(mid ? [mid] : [])];
  return {
    to: [to],
    subject: /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`.trim(),
    ...(mid ? { in_reply_to: mid } : {}),
    ...(refs.length ? { references: [...new Set(refs)].slice(-REFS_KEEP) } : {}),
  };
}
