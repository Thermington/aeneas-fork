import type { Hub } from "../hub.js";
import type { MailCard } from "../mail-cards.js";

/**
 * Where the Mail screen's mail comes from (CONTRACT.md, Mail): one InboxSource per kind of mailbox. mail-inbox.ts keeps
 * what a source lists, and asks it to move mail for Done and Undo; it knows nothing else about the mailbox. iCloud
 * (imports/icloud.ts, icloudInbox) is the only source today; another (a Gmail account) is one more file like it, added
 * to INBOX_SOURCES in mail-inbox.ts. The screen, bundles, Pin and Snooze stay as they are.
 *
 * A source must keep to what iCloud's does: list the Inbox (and the owner's replies to it) without marking anything read, fetch only what it lists
 * (text, the HTML for showing, pictures sent inside a mail), and change the mailbox only by moving a kept message
 * between the Inbox and the archive, or by marking one read or unread, after checking it is still that message, and by
 * adding a draft the owner wrote to its Drafts folder (never sending one).
 */

export interface MailAddress { name: string; address: string }

/** One Inbox message for the Mail screen. Kept only in memory; mail-inbox.ts decides what is stored. */
export interface InboxMail {
  /** The source's id for the message where it is now (iCloud: `<UIDVALIDITY>:<UID>:<folder>`). */
  id: string;
  at: Date;
  message_id: string | null;
  from: MailAddress;
  /** Set only when replies would go somewhere other than From. */
  reply_to: string | null;
  subject: string;
  /** The text as a person reads it (readingText, links written out as `label (url)`), at most TEXT_MAX. */
  text: string;
  /** Sent by a system (a shipping notice, an alert, a newsletter), not a person. */
  automated: boolean;
  /** It carries List-Unsubscribe: marketing mail or a newsletter, most of the time. */
  unsubscribe: boolean;
  /** Its List-Id, when it comes from a mailing list (at most 200 characters). */
  list_id: string | null;
  /** Its HTML cleaned for showing (mail-html.ts), pictures sent inside it written in; null when it has none or too much. */
  html: string | null;
  /** The web pictures its HTML shows, to be fetched by the hub (`<img data-r="N">`). */
  remote: string[];
  /** The brand's logo the mail provider verified (BIMI with a mark certificate), fetched by the hub; or null. */
  logo: { domain: string; url: string } | null;
  /** The Message-IDs it answers (`In-Reply-To` and `References`), which put it in a thread. */
  refs: string[];
  /** The owner's own: a reply from the Sent folder, kept only while its thread is. */
  mine: boolean;
  /** Its key facts (mail-cards.ts, mailCards): from the sender's schema.org data in its HTML, or patterns in its text. */
  cards?: MailCard[];
}

/**
 * One refresh of a mailbox's Inbox:
 * - `present`: the id of every message in the Inbox now, so the hub can tell what left it; null when that cannot be
 *   said (no Inbox found), and then nothing is taken away;
 * - `mails`: messages since the time asked that the hub does not keep yet, newest first (`more` when there were too
 *   many for one refresh);
 * - `moved`: kept messages (by Message-ID) found under another id, not fetched again;
 * - `seen`: of `present`, the ids the mailbox has as read (read in another mail app counts), or null when not known;
 * - `mails` also holds the owner's replies (`mine`) from the sent mail that answer kept mail or mail listed now;
 * - `refs`: kept messages (`needsRefs`) with the Message-IDs they answer, for mail kept before threads.
 */
export interface InboxListing { present: string[] | null; seen: string[] | null; /** Of `present`, the ids the mailbox has flagged (pinned here); absent or null when not known. */ flagged?: string[] | null; mails: InboxMail[]; moved: { id: string; message_id: string }[]; more: boolean; refs?: { id: string; refs: string[] }[]; /** How far the Sent folder has been read (`<UIDVALIDITY>:<UID>`), for the next refresh's `sentFrom`; absent when it was not read. */ sentAt?: string }

/** One kept message to move: its id where it is, and the Message-ID the hub kept for it. */
export interface MoveRef { id: string; message_id: string | null }

export interface InboxSource {
  /** The start of its accounts' keys (`icloud:`), which also tell which source an account is. */
  prefix: string;
  /** Its linked accounts whose Inbox the Mail screen shows, as keys (`icloud:robin@icloud.com`). */
  accounts(hub: Hub): string[];
  /** One refresh (see InboxListing). `known` and `knownMessage` say what the hub keeps already. `owner`: Refresh pressed. */
  list(hub: Hub, account: string, since: Date, known: (id: string) => boolean, knownMessage: (messageId: string) => boolean, opts: { owner?: boolean; needsRefs?: (id: string) => boolean; sentFrom?: string | null }): Promise<InboxListing>;
  /** Done (to the archive) or Undo (back to the Inbox): each message's new id, or null when it was not moved. */
  move(hub: Hub, account: string, refs: MoveRef[], to: "archive" | "inbox"): Promise<Map<string, string | null>>;
  /** Mark a kept message read or unread in the mailbox, after checking it is still that message; false when it was not. */
  setSeen(hub: Hub, account: string, refs: MoveRef[], seen: boolean): Promise<boolean[]>;
  /** Pin or unpin as the mailbox's own flag (`\Flagged` in IMAP: Apple Mail's flag), fenced as setSeen; true for each one changed. */
  setFlagged?(hub: Hub, account: string, refs: MoveRef[], flagged: boolean): Promise<boolean[]>;
  /** Save a draft (an RFC 5322 message, mail-compose.ts) to the mailbox's Drafts folder; it throws when not saved. Never sends. */
  saveDraft?(hub: Hub, account: string, raw: Buffer): Promise<void>;
  /** Delete (to Trash), Spam (to Junk), Not spam and Move to: each message's new id, or null when it was not moved (MOVE only). */
  moveTo?(hub: Hub, account: string, refs: MoveRef[], dest: import("./icloud.js").MoveDest): Promise<Map<string, string | null>>;
  /** The mailbox's other folders (Drafts, Sent, Junk, Trash, its own), read-only like the Inbox: see FolderListing. */
  listFolders?(hub: Hub, account: string, since: Date, known: (id: string) => boolean): Promise<import("./icloud.js").FolderListing[]>;
}
