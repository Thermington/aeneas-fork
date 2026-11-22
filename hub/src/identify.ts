import net from "node:net";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import type { Hub } from "./hub.js";
import type { Category } from "./machineinfo.js";
import { readMachineInfo, updateMachineInfo } from "./machineinfo.js";
import { loadHosts, readMachines } from "./ai/hosts.js";
import { techThings, targetHost } from "./tech.js";
import { errCode } from "./logsafe.js";
import { nextMatch } from "./imports/mail-text.js";

/**
 * What kind of device each thing in Tech is (Tech, since 2026-11-20): a computer (servers, NAS and VMs too), network
 * gear, a printer, a camera, or another device. Only from what the device itself says, with the facts shown beside it:
 * - a machine the hub signs in to: the OS it reports (hostsensors.ts);
 * - a virtual machine or container: its Proxmox host lists it;
 * - anything else in Tech, asked over the network once a day with read-only requests: which well-known service ports
 *   accept a connection, and what those services report: the SSH greeting, the web page's title, a printer's make and
 *   model over IPP, an SNMP description, an RTSP server's name.
 * The facts are weighed (classify): a kind only with decent confidence, else not identified. The apps show the kind and,
 * where a device names itself plainly, its model; never the facts, which are kept for the assistant. Only devices
 * already in Tech are asked; nothing else on the network is contacted.
 */

export interface Signals {
  os?: string;
  vmOf?: string;
  container?: boolean;
  /** Set in Machines as a Windows or Mac machine by the owner. */
  addedAs?: "windows" | "macos";
  open?: number[];
  ssh?: string;
  http?: string;
  ipp?: string;
  snmp?: string;
  rtsp?: string;
}

const NETWORK_OS = /\b(UniFi|OpenWrt|RouterOS|pfSense|OPNsense|EdgeOS|VyOS|DD-WRT|Tomato|Omada)\b/i;
const PRINTER_WORDS = /\b(printer|laserjet|officejet|deskjet|envy|pixma|imageclass|ecosys|workforce|ecotank|brother|lexmark|xerox|ricoh|kyocera|bizhub|imagerunner)\b/i;
const CAMERA_WORDS = /\b(camera|ip ?cam|ipc|nvr|dvr|hikvision|dahua|amcrest|reolink|axis|unifi protect|foscam|wyze)\b/i;
const NETWORK_WORDS = /\b(switch|router|gateway|access point|unifi|edgeswitch|edgerouter|routeros|mikrotik|cisco ios|aruba|netgear|tp-?link|omada|ubiquiti|openwrt|pfsense|opnsense)\b/i;
const STORAGE_OR_SERVER_WORDS = /\b(qnap|qts|synology|diskstation|truenas|freenas|unraid|proxmox|esxi|vmware|windows server)\b/i;
const OTHER_WORDS = /\b(chromecast|apple ?tv|sonos|roku|smart ?tv|homepod|hue bridge|home assistant|shield)\b/i;
const DISTRO = /\b(Debian|Ubuntu|Raspbian|FreeBSD|Fedora|CentOS|Red Hat|Rocky|Alma|Alpine|Arch|openSUSE|NetBSD|OpenBSD)\b/i;

/** Ports a device is asked about, with what an open one says in words. */
export const PORTS: Record<number, string> = {
  22: "SSH", 53: "DNS", 80: "web", 88: "Kerberos", 389: "LDAP", 443: "web", 445: "file sharing", 515: "printing (LPD)",
  548: "file sharing (AFP)", 554: "video stream (RTSP)", 631: "printing (IPP)", 3389: "Remote Desktop", 5000: "web",
  5001: "web", 5900: "screen sharing", 8006: "Proxmox", 8080: "web", 8443: "web", 8554: "video stream (RTSP)", 9100: "printing",
};

/**
 * What a device is: a kind only with decent confidence, else nothing (shown as Not identified). `model` is the exact
 * name a device gave for itself where one service gives it plainly (a printer over IPP). `facts` are short notes of
 * what was seen, kept for the assistant only; the apps never show them.
 */
export interface Identity { category?: Category; confidence: number; model?: string; facts: string[] }

/** How strongly each fact points at a kind, 0 to 1. */
type Vote = [Category, number, string];

/** At least this sure, and this far ahead of the next kind, or not identified. */
export const SURE = 0.75;
export const AHEAD = 0.25;

/**
 * Every fact votes for a kind with a weight; the votes for one kind combine (two independent facts make it surer:
 * 1 minus the product of their doubts). A device is that kind only when the best is sure enough and well ahead of the
 * next; otherwise it is not identified. What the device itself runs (its OS, being a Proxmox guest) settles it.
 */
export function classify(s: Signals): Identity {
  const open = new Set(s.open ?? []);
  const votes: Vote[] = [];
  if (s.os) votes.push([NETWORK_OS.test(s.os) ? "network" : "computer", 1, `runs ${s.os}`]);
  if (s.vmOf) votes.push(["computer", 1, `${s.container ? "container" : "virtual machine"} on ${s.vmOf}`]);
  if (s.addedAs) votes.push(["computer", 0.9, `added as a ${s.addedAs} machine`]);
  if (s.ipp) votes.push(["printer", 0.95, `IPP: ${s.ipp}`]);
  if (s.snmp) {
    const d = s.snmp;
    const kind: Category | null = PRINTER_WORDS.test(d) ? "printer" : CAMERA_WORDS.test(d) ? "camera" : NETWORK_WORDS.test(d) ? "network" : STORAGE_OR_SERVER_WORDS.test(d) || /\b(Windows|Linux|Darwin)\b/.test(d) ? "computer" : null;
    if (kind) votes.push([kind, 0.85, `SNMP: ${d.slice(0, 80)}`]);
  }
  const port = (p: number, kind: Category, w: number) => { if (open.has(p)) votes.push([kind, w, `port ${p} (${PORTS[p] ?? "open"})`]); };
  port(3389, "computer", 0.85); port(445, "computer", 0.8); port(548, "computer", 0.8); port(5900, "computer", 0.7); port(8006, "computer", 0.9);
  if (open.has(389) && open.has(88)) votes.push(["computer", 0.9, "ports 389 and 88 (domain controller)"]);
  if (s.http) {
    const t = s.http;
    const kind: Category | null = NETWORK_WORDS.test(t) ? "network" : STORAGE_OR_SERVER_WORDS.test(t) ? "computer" : PRINTER_WORDS.test(t) ? "printer" : CAMERA_WORDS.test(t) ? "camera" : OTHER_WORDS.test(t) ? "other" : null;
    if (kind) votes.push([kind, 0.7, `web title: ${t.slice(0, 80)}`]);
  }
  port(9100, "printer", 0.75); port(631, "printer", 0.45); port(515, "printer", 0.45);
  if (s.rtsp) votes.push(["camera", CAMERA_WORDS.test(s.rtsp) ? 0.85 : 0.6, `RTSP: ${s.rtsp.slice(0, 60)}`]);
  else { port(554, "camera", 0.4); port(8554, "camera", 0.4); }
  port(53, "network", 0.35);
  if (s.ssh && DISTRO.test(s.ssh)) votes.push(["computer", 0.4, `SSH: ${s.ssh.slice(0, 60)}`]);

  const doubt = new Map<Category, number>();
  for (const [k, w] of votes) doubt.set(k, (doubt.get(k) ?? 1) * (1 - w));
  const ranked = [...doubt].map(([k, d]) => [k, 1 - d] as const).sort((a, b) => b[1] - a[1]);
  const [best, next] = ranked;
  const facts = votes.map((v) => v[2]);
  const round = (n: number) => Math.round(n * 100) / 100;
  if (!best || best[1] < SURE || best[1] - (next?.[1] ?? 0) < AHEAD) return { confidence: round(best?.[1] ?? 0), facts };
  return { category: best[0], confidence: round(best[1]), ...(best[0] === "printer" && s.ipp ? { model: s.ipp.slice(0, 80) } : {}), facts };
}

// ---------- read-only probes ----------

const PROBE_MS = 2500;

/** Whether a TCP port accepts a connection, and the first line it sends unasked (an SSH greeting). */
function tcp(host: string, port: number, ms = PROBE_MS): Promise<{ open: boolean; greeting?: string }> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    let buf = "";
    const finish = (open: boolean) => { if (done) return; done = true; s.destroy(); resolve({ open, ...(buf ? { greeting: buf.split(/\r?\n/)[0].slice(0, 200) } : {}) }); };
    s.setTimeout(ms, () => finish(!!s.remoteAddress && s.readyState === "open"));
    s.once("connect", () => { if (port !== 22) finish(true); else setTimeout(() => finish(true), 1200); });
    // Only the new piece is looked at for the line's end, and only the start is kept: a device that sends megabytes
    // with no line break neither fills the hub's memory nor has all it sent read again with every piece.
    s.on("data", (d) => { const t = d.toString("latin1"); if (buf.length < 4096) buf += t; if (t.includes("\n")) finish(true); });
    s.once("error", () => finish(false));
  });
}

/**
 * A web page's title: what `/<title[^>]*>([^<]{1,200})<\/title>/i` found, in one pass. As that pattern it searched to
 * the end of the page again from every `<title` that was never closed: a device's page of nothing but `<title` (the
 * 64 KB and more read of it) held the hub for more than a second.
 */
export function webPageTitle(body: string): string | undefined {
  const open = /<title/gi;
  const gt = nextMatch(body, />/g);
  const lt = nextMatch(body, /</g);
  for (let m = open.exec(body); m; m = open.exec(body)) {
    const g = gt(open.lastIndex);
    if (g.at < 0) return undefined; // no ">" from here on: no later <title has one either
    // The title is what runs from the ">" to the next "<", which must start "</title>", 1 to 200 characters.
    const c = lt(g.end);
    if (c.at < 0) return undefined;
    if (c.at > g.end && c.at - g.end <= 200 && /^<\/title>/i.test(body.slice(c.at, c.at + 8))) return body.slice(g.end, c.at);
  }
  return undefined;
}

/** The title of a device's web page (or its Server header), following one redirect on the same device. */
function webTitle(host: string, port: number, secure: boolean, path = "/", hop = 0): Promise<string | undefined> {
  return new Promise((resolve) => {
    const mod = secure ? https : http;
    const req = mod.request({ host, port, path, method: "GET", timeout: PROBE_MS, rejectUnauthorized: false, headers: { "user-agent": "aeneas-hub-identify" } }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && hop === 0) {
        res.resume();
        try {
          const u = new URL(loc, `${secure ? "https" : "http"}://${host}:${port}`);
          if (u.hostname === host) { resolve(webTitle(host, Number(u.port) || (u.protocol === "https:" ? 443 : 80), u.protocol === "https:", u.pathname + u.search, 1)); return; }
        } catch { /* a bad Location: read this page */ }
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { if (body.length < 65536) body += c; });
      res.on("end", () => {
        const t = webPageTitle(body);
        const text = (t ?? (typeof res.headers.server === "string" ? res.headers.server : "")).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
        resolve(text || undefined);
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

/** An RTSP server's name from OPTIONS (cameras), or undefined. */
function rtspServer(host: string, port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let buf = "";
    const done = (v?: string) => { s.destroy(); resolve(v); };
    s.setTimeout(PROBE_MS, () => done(undefined));
    s.once("connect", () => s.write(`OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: aeneas-hub-identify\r\n\r\n`));
    s.on("data", (d) => {
      buf += d.toString("latin1");
      if (!/\r\n\r\n/.test(buf)) return;
      if (!/^RTSP\/1\.\d/.test(buf)) return done(undefined);
      done(/^Server:\s*(.+)$/im.exec(buf)?.[1]?.trim() || "an RTSP server");
    });
    s.once("error", () => done(undefined));
  });
}

/** An IPP Get-Printer-Attributes request for printer-make-and-model (RFC 8011), as bytes. */
export function ippRequest(host: string): Buffer {
  const attr = (tag: number, name: string, value: string) => {
    const n = Buffer.from(name), v = Buffer.from(value);
    const b = Buffer.alloc(1 + 2 + n.length + 2 + v.length);
    let o = b.writeUInt8(tag, 0);
    o = b.writeUInt16BE(n.length, o); o += n.copy(b, o);
    o = b.writeUInt16BE(v.length, o); v.copy(b, o);
    return b;
  };
  return Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x0b, 0x00, 0x00, 0x00, 0x01, 0x01]),
    attr(0x47, "attributes-charset", "utf-8"),
    attr(0x48, "attributes-natural-language", "en"),
    attr(0x45, "printer-uri", `ipp://${host}:631/ipp/print`),
    attr(0x44, "requested-attributes", "printer-make-and-model"),
    Buffer.from([0x03]),
  ]);
}

/** printer-make-and-model from an IPP response, or undefined. */
export function ippMakeAndModel(b: Buffer): string | undefined {
  if (b.length < 9) return undefined;
  let o = 8;
  while (o < b.length) {
    const tag = b[o++];
    if (tag === 0x03) break;
    if (tag < 0x10) continue; // a group tag
    if (o + 2 > b.length) break;
    const nl = b.readUInt16BE(o); o += 2;
    const name = b.toString("utf8", o, o + nl); o += nl;
    if (o + 2 > b.length) break;
    const vl = b.readUInt16BE(o); o += 2;
    const value = b.toString("utf8", o, o + vl); o += vl;
    if (name === "printer-make-and-model" && value.trim()) return value.trim();
  }
  return undefined;
}

function ipp(host: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const body = ippRequest(host);
    const req = http.request({ host, port: 631, path: "/ipp/print", method: "POST", timeout: PROBE_MS, headers: { "content-type": "application/ipp", "content-length": body.length } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve(res.headers["content-type"]?.includes("application/ipp") ? ippMakeAndModel(Buffer.concat(parts)) : undefined));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end(body);
  });
}

/** An SNMPv2c GET of sysDescr.0 with the read-only community "public", as bytes. */
export function snmpRequest(id = 0x2a): Buffer {
  const oid = [0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00]; // 1.3.6.1.2.1.1.1.0
  const tlv = (t: number, body: number[]) => [t, body.length, ...body];
  const varbind = tlv(0x30, [...tlv(0x06, oid), 0x05, 0x00]);
  const pdu = tlv(0xa0, [...tlv(0x02, [id]), ...tlv(0x02, [0]), ...tlv(0x02, [0]), ...tlv(0x30, varbind)]);
  return Buffer.from(tlv(0x30, [...tlv(0x02, [1]), ...tlv(0x04, [...Buffer.from("public")]), ...pdu]));
}

/** sysDescr from an SNMP response: the octet string after the sysDescr OID, or undefined. */
export function snmpSysDescr(b: Buffer): string | undefined {
  const oid = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x01, 0x00]);
  const at = b.indexOf(oid);
  if (at < 0 || b[at + oid.length] !== 0x04) return undefined;
  let o = at + oid.length + 1;
  let len = b[o++];
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | b[o++]; }
  const text = b.toString("utf8", o, o + len).replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function snmp(host: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
    const done = (v?: string) => { clearTimeout(t); try { sock.close(); } catch { /* closed */ } resolve(v); };
    const t = setTimeout(() => done(undefined), PROBE_MS);
    sock.on("message", (m) => done(snmpSysDescr(m)));
    sock.on("error", () => done(undefined));
    sock.send(snmpRequest(), 161, host, (e) => { if (e) done(undefined); });
  });
}

/** Ask one device what it is: the ports first, then only the services that answered. */
export async function probe(host: string): Promise<Signals> {
  const ports = Object.keys(PORTS).map(Number);
  const results = await Promise.all(ports.map(async (p) => [p, await tcp(host, p)] as const));
  const open = results.filter(([, r]) => r.open).map(([p]) => p);
  const greeting = results.find(([p]) => p === 22)?.[1].greeting;
  const web = open.includes(443) ? [443, true] as const : open.includes(80) ? [80, false] as const : open.includes(8443) ? [8443, true] as const : open.includes(8080) ? [8080, false] as const : open.includes(5001) ? [5001, true] as const : open.includes(5000) ? [5000, false] as const : null;
  const [title, printer, descr, stream] = await Promise.all([
    web ? webTitle(host, web[0], web[1]) : Promise.resolve(undefined),
    open.includes(631) ? ipp(host) : Promise.resolve(undefined),
    snmp(host),
    open.includes(554) ? rtspServer(host, 554) : open.includes(8554) ? rtspServer(host, 8554) : Promise.resolve(undefined),
  ]);
  return { open, ...(greeting?.startsWith("SSH-") ? { ssh: greeting } : {}), ...(title ? { http: title } : {}), ...(printer ? { ipp: printer } : {}), ...(descr ? { snmp: descr } : {}), ...(stream ? { rtsp: stream } : {}) };
}

// ---------- the daily pass ----------

const DAY_MS = 24 * 3600_000;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Identify every thing in Tech that is due (never identified, or a day ago): from what is already known when the hub
 * signs in to it or its Proxmox host lists it, else by asking it at the address its checks use. Places and web services
 * on the internet are left out.
 */
export async function identifyTick(hub: Hub, now: Date = new Date(), ask: (host: string) => Promise<Signals> = probe): Promise<number> {
  const info = readMachineInfo(hub);
  const reachable = new Set(loadHosts(hub.cfg).flatMap((h) => h.aliases.concat(h.name)));
  const added = new Map((readMachines(hub.cfg) ?? []).map((m) => [m.name.trim().toLowerCase(), m.os]));
  const monitors = new Map(hub.store.list({ kind: "monitor", limit: 100000 }).map((m) => [m.id, m]));
  let done = 0;
  const due = techThings(hub).filter((t) => t.kind === "machine");
  const jobs = due.map(async (t) => {
    const i = info[t.name] ?? {};
    const fresh = i.ident_at && now.getTime() - Date.parse(i.ident_at) < DAY_MS;
    const known: Signals = {
      ...(i.os ? { os: i.os } : {}),
      ...(i.vm_of ? { vmOf: i.vm_of } : {}),
      ...(added.get(t.name) === "windows" || added.get(t.name) === "macos" ? { addedAs: added.get(t.name) as "windows" | "macos" } : {}),
    };
    // What the hub already knows from the machine itself needs no asking.
    if (known.os || known.vmOf || known.addedAs) {
      const id = classify(known);
      if (id.category !== i.category) updateMachineInfo(hub, t.name, { category: id.category, confidence: id.confidence, facts: id.facts, ident_at: now.toISOString() });
      return;
    }
    if (fresh || reachable.has(t.name)) return;
    const address = t.monitors.map((id) => monitors.get(id)).map((m) => (m ? targetHost(String(m.fields.type ?? ""), String(m.fields.target ?? "")) : "")).find((h) => h && (IPV4.test(h) || !h.includes(".") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".ts.net")));
    if (!address) return;
    try {
      const s = await ask(address);
      const id = classify(s);
      updateMachineInfo(hub, t.name, { category: id.category ?? null, model: id.model ?? null, confidence: id.confidence, facts: id.facts, services: s.open ?? [], ident_at: now.toISOString() });
      done++;
    } catch (e) {
      console.error(`[identify] a device could not be asked: ${errCode(e)}`);
    }
  });
  await Promise.all(jobs);
  return done;
}

/** Hourly: whatever is due is identified (a device is asked at most once a day). First pass two minutes after start. */
export function startIdentifyLoop(hub: Hub, intervalMs = 3600_000): () => void {
  if (!hub.cfg.hostSensors) return () => {};
  let running = false;
  const tick = () => {
    if (running || !hub.modules.on("homelab")) return;
    running = true;
    identifyTick(hub)
      .then((n) => { if (n) console.log(`[identify] ${n} device(s) asked what they are`); })
      .catch((e) => console.error(`[identify] pass failed: ${errCode(e)}`))
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 120_000).unref();
  return () => clearInterval(timer);
}

/** The categories in the Overview's order, with their section titles (shared with the apps through GET /ops). */
export const CATEGORY_TITLES: Record<Category, string> = { computer: "Computers", network: "Network", printer: "Printers", camera: "Cameras", other: "Other devices" };
