import { useEffect, useState } from "react";
import type { AlertInfo } from "../sync/api";
import { engine } from "../sync/engine";

/**
 * Which kinds of alert are on (GET /modules, `alerts`): one setting for every device, each kind switched on its own
 * in Settings, Notifications. The hub holds back a switched-off kind, so most alerts need nothing here; this is for
 * the alerts this app makes itself from its own copy (the reminder banner) and for the settings page. Kept for the
 * next visit, refreshed on open and whenever a device changes a switch. A kind not known counts as on, and so does
 * every kind on a hub too old to list them.
 */
const KEY = "ea-alerts";
let cached: AlertInfo[] | null = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "null") as AlertInfo[] | null; } catch { return null; }
})();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let subscribed = false;

function keep(list: AlertInfo[]): void {
  cached = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private window */ }
  listeners.forEach((f) => f());
}

export function refreshAlerts(): Promise<void> {
  const c = engine.client;
  if (!subscribed) { subscribed = true; engine.onAlerts(keep); }
  if (!c) return Promise.resolve();
  loading ??= c.modules().then((r) => { if (Array.isArray(r.alerts)) keep(r.alerts); }).catch(() => undefined).finally(() => { loading = null; });
  return loading;
}

/** Switch kinds of alert on or off for every device; the answer becomes the list. */
export async function setAlerts(changes: Record<string, boolean>): Promise<AlertInfo[]> {
  const c = engine.client;
  if (!c) throw new Error("Not connected to a hub");
  const r = await c.setAlerts(changes);
  keep(r.alerts);
  return r.alerts;
}

/** Whether a kind of alert is on in a list (a kind the list does not have is on, and so is every kind with no list). */
export function alertOn(list: AlertInfo[] | null, kind: string): boolean {
  const a = list?.find((x) => x.id === kind);
  return a ? a.on : true;
}

/** The switches to list: every kind whose module is on (a kind of no module always shows). */
export function shownAlerts(list: AlertInfo[] | null, moduleOn: (id: string | undefined) => boolean): AlertInfo[] {
  return (list ?? []).filter((a) => moduleOn(a.module));
}

/** The alert list (null until known, or on an older hub) and a checker; rerenders when any switch changes. */
export function useAlerts(): { list: AlertInfo[] | null; on: (kind: string) => boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    listeners.add(f);
    void refreshAlerts();
    return () => { listeners.delete(f); };
  }, []);
  const list = cached;
  return { list, on: (kind) => alertOn(list, kind) };
}
