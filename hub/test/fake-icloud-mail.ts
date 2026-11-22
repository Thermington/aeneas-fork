import { Readable } from "node:stream";
import type { TestHub } from "./helpers.js";
import { setImapFactory, type ImapClient, type ImapFolder, type ImapLogin } from "../src/imports/icloud.js";

// A fake iCloud for the Mail screen's tests (icloud-inbox, mail-inbox, mail-routes). Not a test file itself.
export const PASSWORD = "abcd-efgh-ijkl-mnop";
export const EMAIL = "robin@icloud.example";
export const ACCOUNT = `icloud:${EMAIL}`;

export interface Msg {
  uid: number;
  folder: string;
  at: Date;
  subject: string;
  from: { name?: string; address: string };
  replyTo?: { address: string };
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  /** To and Cc; To is the owner unless set. */
  to?: { name?: string; address: string }[];
  cc?: { name?: string; address: string }[];
  plain?: string;
  html?: string;
  /** Raw header lines (List-Unsubscribe and the like), as the server sends them. */
  headers?: string;
  /** Read (the \Seen flag). */
  seen?: boolean;
  /** Flagged (Apple Mail's flag; a pin on the Mail screen). */
  flagged?: boolean;
  /** Attachments (only with `plain`): parts 2, 3, … after the text; `inlineId` makes one a picture shown inside the mail. */
  files?: { name: string; type: string; bytes: Buffer; inlineId?: string }[];
}

export const FOLDERS: ImapFolder[] = [
  { path: "INBOX", flags: new Set() },
  { path: "Archive", specialUse: "\\Archive", flags: new Set() },
  { path: "Junk", specialUse: "\\Junk", flags: new Set() },
  { path: "Deleted Messages", specialUse: "\\Trash", flags: new Set() },
  { path: "Drafts", specialUse: "\\Drafts", flags: new Set() },
  { path: "Sent Messages", specialUse: "\\Sent", flags: new Set() },
  { path: "[Group]", flags: new Set(["\\Noselect"]) },
];

/** A fake iCloud for the Mail screen: folders, messages, and a record of every call and query. */
export function fake(messages: Msg[], opts: { password?: string; noMove?: boolean } = {}) {
  const seen = { connects: 0, logouts: 0, calls: [] as string[], opened: [] as { path: string; readOnly: unknown }[], fetches: [] as unknown[], searches: [] as Record<string, unknown>[], moves: [] as { from: string; uid: number; to: string }[], flags: [] as { uid: number; flags: string[]; add: boolean }[], appends: [] as { path: string; raw: string; flags: string[] }[], downloads: [] as string[] };
  const logins: ImapLogin[] = [];
  setImapFactory((login) => {
    logins.push(login);
    let open: string | null = null;
    const find = (uid: string) => messages.find((m) => m.folder === open && String(m.uid) === uid);
    const c: ImapClient = {
      async connect() {
        seen.calls.push("connect"); seen.connects++;
        if (login.pass !== (opts.password ?? PASSWORD)) throw Object.assign(new Error("Authentication failed"), { authenticationFailed: true });
      },
      async logout() { seen.calls.push("logout"); seen.logouts++; },
      close() { seen.calls.push("close"); },
      async list() { seen.calls.push("list"); return FOLDERS; },
      async mailboxOpen(p, o) {
        seen.calls.push("mailboxOpen"); seen.opened.push({ path: p, readOnly: (o as { readOnly?: unknown }).readOnly });
        if (!FOLDERS.some((f) => f.path === p)) throw Object.assign(new Error("no such folder"), { responseStatus: "NO" });
        open = p;
        return { uidValidity: 7n };
      },
      async search(q) {
        seen.calls.push("search"); seen.searches.push(q);
        const since = q.all ? new Date(0) : q.since as Date;
        return messages.filter((m) => m.folder === open && m.at >= since).map((m) => m.uid);
      },
      async fetchOne(uid, query, o) {
        seen.calls.push("fetchOne"); seen.fetches.push({ query, o });
        const m = find(uid);
        if (!m) return false;
        const parts = [m.plain !== undefined ? { type: "text/plain" } : null, m.html !== undefined ? { type: "text/html" } : null].filter(Boolean) as { type: string }[];
        // With files: the text as part 1, each file a part after it, as a server lists a multipart/mixed message.
        const files = (m.files ?? []).map((f, i) => ({
          part: String(i + 2), type: f.type, size: Math.ceil(f.bytes.length / 3) * 4, encoding: "base64",
          ...(f.inlineId ? { id: `<${f.inlineId}>`, disposition: "inline" } : { disposition: "attachment", dispositionParameters: { filename: f.name } }),
        }));
        return {
          internalDate: m.at,
          envelope: { date: m.at, subject: m.subject, messageId: m.messageId && `<${m.messageId}>`, inReplyTo: m.inReplyTo && `<${m.inReplyTo}>`, from: [m.from], replyTo: [m.replyTo ?? m.from], to: m.to ?? [{ name: "Robin", address: EMAIL }], cc: m.cc ?? [] },
          bodyStructure: files.length ? { type: "multipart/mixed", childNodes: [{ ...parts[0], part: "1" }, ...files] } : parts.length === 1 ? parts[0] : { type: "multipart/alternative", childNodes: parts.map((p, i) => ({ ...p, part: String(i + 1) })) },
          ...(query.headers ? { headers: Buffer.from(`${m.references ? `References: ${m.references}\r\n` : ""}${m.headers ?? ""}\r\n`) } : {}),
        };
      },
      async *fetch() {
        seen.calls.push("fetch");
        for (const m of messages.filter((x) => x.folder === open)) yield { uid: m.uid, flags: new Set([...(m.seen ? ["\\Seen"] : []), ...(m.flagged ? ["\\Flagged"] : [])]) };
      },
      ...({
        async messageFlagsAdd(uid: string, flags: string[]) {
          seen.calls.push("messageFlagsAdd"); seen.flags.push({ uid: Number(uid), flags, add: true });
          const m = find(uid); if (m) { if (flags[0] === "\\Flagged") m.flagged = true; else m.seen = true; } return !!m;
        },
        async messageFlagsRemove(uid: string, flags: string[]) {
          seen.calls.push("messageFlagsRemove"); seen.flags.push({ uid: Number(uid), flags, add: false });
          const m = find(uid); if (m) { if (flags[0] === "\\Flagged") m.flagged = false; else m.seen = false; } return !!m;
        },
        /** APPEND: a draft the Mail screen saved, recorded as sent to the server. */
        async append(path: string, content: Buffer, flags: string[]) {
          seen.calls.push("append"); seen.appends.push({ path, raw: content.toString(), flags });
          return { uid: seen.appends.length };
        },
        capabilities: new Map<string, unknown>(opts.noMove ? [] : [["MOVE", true], ["UIDPLUS", true]]),
        /** MOVE: the message goes to the destination folder under the next UID there. */
        async messageMove(uid: string, destination: string) {
          seen.calls.push("messageMove"); seen.moves.push({ from: open!, uid: Number(uid), to: destination });
          const m = find(uid);
          if (!m) return false;
          const next = Math.max(0, ...messages.filter((x) => x.folder === destination).map((x) => x.uid)) + 100;
          const old = m.uid;
          m.folder = destination;
          m.uid = next;
          return { uidValidity: 7n, uidMap: new Map([[old, next]]) };
        },
      } as object),
      async download(uid, part) {
        seen.calls.push("download");
        const m = find(uid)!;
        if (m.files?.length && part !== "1") {
          const f = m.files[Number(part) - 2];
          seen.downloads.push(part);
          return { content: Readable.from([f ? f.bytes : Buffer.alloc(0)]) };
        }
        const both = m.plain !== undefined && m.html !== undefined;
        const body = both ? (part === "1" ? m.plain! : m.html!) : (m.plain ?? m.html ?? "");
        return { content: Readable.from([Buffer.from(body, "utf8")]) };
      },
    };
    return c;
  });
  return Object.assign(seen, { logins });
}

export function linked(t: TestHub, extra: Record<string, unknown> = {}) {
  t.hub.connections.update((c) => { c.icloud = [{ email: EMAIL, password: PASSWORD, linked_at: new Date().toISOString(), ...extra }]; });
}
export const done = (t: TestHub) => { setImapFactory(null); t.cleanup(); };
export const ago = (days: number) => new Date(Date.now() - days * 86400_000);
