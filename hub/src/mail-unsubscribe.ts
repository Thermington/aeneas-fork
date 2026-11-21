import { isAddress } from "./mail-compose.js";

/**
 * Unsubscribe (CONTRACT.md, Mail): the ways a mail's List-Unsubscribe header offers, as the hub takes them. Everything
 * here is the sender's: only an https address without a login in it (one-click when List-Unsubscribe-Post says so,
 * else a page to open), and only a plain mailto address; nothing else is used.
 */
export interface UnsubscribeWays {
  /** RFC 8058: the hub POSTs `List-Unsubscribe=One-Click` here (the owner confirms). */
  one_click?: string;
  /** A page the owner opens in their browser. */
  link?: string;
  /** An address to write to: a draft the owner sends. */
  mailto?: { to: string; subject: string };
}

const https = (raw: string): string | null => {
  if (raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
};

export function unsubscribeWays(header: string, post: string): UnsubscribeWays {
  const out: UnsubscribeWays = {};
  const oneClick = /List-Unsubscribe\s*=\s*One-Click/i.test(post);
  for (const m of header.slice(0, 8000).matchAll(/<([^<>\s]{1,2000})>/g)) {
    const v = m[1];
    if (/^https:/i.test(v)) {
      const url = https(v);
      if (!url) continue;
      if (oneClick && !out.one_click) out.one_click = url;
      else if (!out.link) out.link = url;
    } else if (/^mailto:/i.test(v) && !out.mailto) {
      const [addr, query = ""] = v.slice(7).split("?");
      let to = "";
      try { to = decodeURIComponent(addr).trim().toLowerCase(); } catch { continue; }
      if (!isAddress(to)) continue;
      let subject = "unsubscribe";
      try { subject = (new URLSearchParams(query).get("subject") ?? "unsubscribe").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "unsubscribe"; } catch { /* the default */ }
      out.mailto = { to, subject };
    }
  }
  return out;
}

/** A blocked sender as kept: an address, or `@domain` for a whole domain (and its subdomains). */
export function blockedForm(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s.startsWith("@")) return /^@([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(s) ? s : null;
  return isAddress(s) ? s : null;
}

/** Whether an address is one of the blocked: the address itself, or under a blocked domain. */
export function isBlocked(blocked: string[], address: string): boolean {
  const a = address.trim().toLowerCase();
  const domain = a.split("@")[1] ?? "";
  return blocked.some((b) => (b.startsWith("@") ? domain === b.slice(1) || domain.endsWith(`.${b.slice(1)}`) : b === a));
}
