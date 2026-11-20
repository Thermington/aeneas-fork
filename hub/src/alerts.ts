import fs from "node:fs";
import path from "node:path";
import type { ModuleId } from "./modules.js";
import { errCode } from "./logsafe.js";

/**
 * Alerts, each optional on its own (since 2026-11-20). Every `notify` event the hub announces has a kind (bus.ts), and
 * the owner can switch each kind off without touching the others or the module it belongs to: reminders without the
 * morning summary, machine alerts without sensor ones, the Mail screen without new-mail alerts.
 *
 * One setting for every device, in `<data>/alerts.json`: `{ "<kind>": false }` for the kinds switched off (a kind
 * missing from the file is on, so a new kind of alert starts on, as its module's own switch already decides whether
 * it exists at all). The hub holds back a switched-off kind where alerts leave it, the `/live` stream (app.ts), so no
 * device shows it, whatever its app's version. Apps that plan alerts themselves (a reminder's local notification on
 * an Apple device, the reminder banner in the web app) read the list from `GET /modules` and plan none for a kind
 * that is off. What the hub does with an event for itself (a sensor's line in a machine's history) is not an alert
 * and goes on.
 */
export interface AlertKind { id: string; title: string; summary: string; module: ModuleId | null }

/** In the order Settings lists them. `module`: the module the alert belongs to; apps leave it out while that is off. */
export const ALERT_KINDS: AlertKind[] = [
  { id: "reminder", title: "Reminders", summary: "A reminder's time has come.", module: "notifications" },
  { id: "digest", title: "Morning summary", summary: "Today's plan, once each morning.", module: "notifications" },
  { id: "activity", title: "Activity check-ins", summary: "You have been on one activity for a long stretch: still on it?", module: null },
  { id: "mail", title: "New mail", summary: "New mail on the Mail screen. Whose mail alerts you, and how much an alert says, is set on the Mail screen.", module: "mail_inbox" },
  { id: "monitor", title: "Machines and services", summary: "A machine, service or backup went down, or came back.", module: "homelab" },
  { id: "sensor", title: "Sensor readings", summary: "A reading went out of its bounds, stopped coming, or came back.", module: "sensors" },
  { id: "disk", title: "Hub disk space", summary: "The disk with the hub's data is almost full.", module: null },
  { id: "quiz", title: "Recall quiz", summary: "The day's quiz questions are ready.", module: "quiz" },
];
const KNOWN = new Set(ALERT_KINDS.map((k) => k.id));

export interface AlertView { id: string; title: string; summary: string; module?: ModuleId; on: boolean }

export class AlertStore {
  private cache: Record<string, boolean> | null = null;
  private listeners = new Set<() => void>();

  constructor(private file: string) {}

  private read(): Record<string, boolean> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
      this.cache = Object.fromEntries(Object.entries(raw).filter(([k, v]) => KNOWN.has(k) && typeof v === "boolean")) as Record<string, boolean>;
    } catch (e) {
      // No file is the start: every kind on. A damaged one is left on disk to mend and counts as every kind on, so
      // no alert goes missing over it.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[alerts] alerts.json could not be read (${errCode(e)}); every kind of alert counts as on`);
      this.cache = {};
    }
    return this.cache;
  }

  /** Whether alerts of this kind go to devices. A kind the hub does not list is on. */
  on(kind: string): boolean { return this.read()[kind] !== false; }

  list(): AlertView[] {
    return ALERT_KINDS.map((k) => ({ id: k.id, title: k.title, summary: k.summary, ...(k.module ? { module: k.module } : {}), on: this.on(k.id) }));
  }

  /** Switch kinds on or off: `{ "<kind>": true|false }`. Unknown kinds and non-booleans are refused, and nothing is saved. */
  set(changes: Record<string, unknown>): AlertView[] {
    const next = { ...this.read() };
    for (const [k, v] of Object.entries(changes)) {
      if (!KNOWN.has(k)) throw new Error(`unknown kind of alert: ${k.slice(0, 40)}`);
      if (typeof v !== "boolean") throw new Error(`${k} must be true or false`);
      if (v) delete next[k]; else next[k] = false;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = next;
    for (const f of this.listeners) { try { f(); } catch (e) { console.error(`[alerts] a listener failed: ${errCode(e)}`); } }
    return this.list();
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }
}
