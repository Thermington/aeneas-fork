import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import { openExternal } from "../tauri/bridge";
import { saveBlob } from "../lib/download";
import { engine } from "../sync/engine";
import { isTypingTarget } from "../lib/keys";
import { useEntities } from "../sync/hooks";
import type { Entity } from "@everythingapp/shared";
import { completeTask, snoozeReminder } from "../sync/actions";
import { usePoll } from "../lib/usePoll";
import { useModules } from "../lib/modules";
import { plainError } from "../lib/errors";
import { fmtDateTime } from "../lib/time";
import {
  bundleClass,
  CARD_ICON,
  swipeAction,
  swipeLock,
  cardTime,
  tripDates,
  tripsOf,
  type Trip,
  cardLine,
  cardLink,
  type MailCard,
  type SearchHit,
  type UnsubscribeOptions,
  httpsLink,
  type MailAddress,
  whereLabel,
  type MailDraft,
  DRAFT_FILES_BYTES,
  DRAFT_FILES_MAX,
  type FolderMail,
  type MailFolder,
  type MoveTarget,
  type MailAttachment,
  fileSize,
  previewSrc,
  riskyFile,
  FOLDER_ICONS,
  folderCount,
  folderLabel,
  folderWho,
  bundleOf,
  deliveryAt,
  dueReminders,
  type DueReminder,
  frameLink,
  inboxAt,
  inboxSections,
  initials,
  isUnread,
  logoSrc,
  MAIL_KEYS,
  mailKeyAction,
  type MailKey,
  matches,
  nameHidesAddress,
  personLabel,
  sendersLine,
  shownBundles,
  snoozeChoices,
  SNOOZE_DEFAULTS,
  textParts,
  threadRows,
  viewMessages,
  whenLabel,
  type Bundle,
  type BundleDelivery,
  type CustomBundle,
  type MailList,
  NOTIFY_DEFAULTS,
  type MailNotify,
  type MailMessage,
  type MailSummary,
  type MailThread,
  type MailView,
  type SnoozeTimes,
  QUOTE_SELECTOR,
  batches,
  OPEN_UNREAD_MAX,
  type TextPart,
} from "../lib/mail";

/**
 * Mail (module mail_inbox): the iCloud Inbox in the app's own look, with Pin, Done and Snooze. Mail grouped by
 * day, kinds of mail gathered into colored bundles, and a side list of Inbox, Snoozed, Done and the bundles; the bar at
 * the top takes the color of where you are. A thread (a back-and-forth, the owner's replies in it) is one row, and opens
 * in place as a card with its messages, the newest open.
 *
 * Mail is hostile input: its HTML only as the hub cleaned it, in a frame where nothing runs (MailFrame), else as text
 * with links only through textParts, which checks them; the sender's real address on every open message; and a brand's
 * logo only when iCloud verified it (the hub checks iCloud's verdict).
 */

/**
 * What the rows and cards need from the screen: the verified logos, the bundles shown, and `act`, which asks the hub to
 * do something to a mail (Pin) and then loads the list again so every row shows it.
 */
interface LookValue {
  logos: Record<string, string>; shown: Bundle[]; act: (run: (c: NonNullable<typeof engine.client>) => Promise<unknown>) => Promise<void>;
  /** Done (to Archive) or back to the Inbox, with an Undo bar afterwards. */
  move: (ids: string[], to: "done" | "inbox") => Promise<void>;
  /** Snooze until a time (with Undo), or bring back now. */
  snooze: (m: MailThread, until: Date) => Promise<void>;
  unsnooze: (m: MailThread) => Promise<void>;
  /** The open mail whose snooze choices show (a row's Snooze opens the mail with them). */
  snoozeFor: string | null; setSnoozeFor: (id: string | null) => void; openMail: (id: string) => void;
  /** The owner's snooze times, from the hub. */
  snoozeTimes: SnoozeTimes;
  /** When each bundle's mail shows in the Inbox, from the hub. */
  delivery: Record<string, BundleDelivery>;
  /** Which new mail notifies, from the hub. */
  notifyOn: MailNotify;
  /** The keyboard's highlighted row (a thread's id, or `bundle:<day>:<bundle>`), and the selected threads. */
  cursor: string | null;
  selected: Set<string>;
  /** Select or unselect a thread; `range`: everything from the last one picked (Shift-click). */
  pick: (id: string, range: boolean) => void;
  /**
   * Delete, Spam, Not spam or Move to (POST /mail/move), with an Undo bar that sends the mail `back` when it can go back
   * (null: no Undo, as for Sent and Drafts, where nothing may be moved).
   */
  relocate: (ids: string[], to: MoveTarget, said: string, back: MoveTarget | null) => Promise<void>;
  /** The mailbox's other folders, for Move to. */
  folders: MailFolder[];
  /** All mail with one person (the people view), and going to a mail where it is (from a search hit). */
  showPerson: (who: MailAddress) => void;
  showInPlace: (h: SearchHit) => void;
}
const Look = createContext<LookValue>({ logos: {}, shown: [], act: async () => {}, move: async () => {}, snooze: async () => {}, unsnooze: async () => {}, snoozeFor: null, setSnoozeFor: () => {}, openMail: () => {}, snoozeTimes: SNOOZE_DEFAULTS, delivery: {}, notifyOn: NOTIFY_DEFAULTS, cursor: null, selected: new Set(), pick: () => {}, relocate: async () => {}, folders: [], showPerson: () => {}, showInPlace: () => {} });
export function Mail() {
  const list = usePoll((c) => c.mailList(), 60_000);
  const { on } = useModules();
  const [view, setView] = useState<MailView>("inbox");
  const [q, setQ] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [openBundles, setOpenBundles] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const shown = shownBundles(on, list.data?.custom_bundles ?? []);
  // A bundle of the owner's being made ("new") or changed, shown in place of the list.
  const [editing, setEditing] = useState<CustomBundle | "new" | null>(null);
  // A view of a bundle whose module was switched off goes back to the Inbox.
  useEffect(() => {
    if (view.startsWith("b:") && !shown.some((b) => b.id === view.slice(2))) setView("inbox");
  }, [view, shown]);

  const threads = useMemo(() => threadRows(list.data?.messages ?? []), [list.data]);
  // The owner's reminders that are due, among the mail in the Inbox (tasks are on every device already).
  const tasks = useEntities("task");
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const reminders = useMemo(() => dueReminders(tasks, new Date(clock)), [tasks, clock]);
  const [remindFor, setRemindFor] = useState<string | null>(null);
  const delivery = list.data?.bundle_delivery ?? {};
  // Search: a thread shows when any of its messages has every word.
  const messages = useMemo(() => (q.trim() ? threads.filter((t) => t.members.some((m) => matches(m, q))) : threads), [threads, q]);
  // The people view: all mail with one person, in the list's place until closed or another view is chosen.
  const [person, setPerson] = useState<MailAddress | null>(null);
  const go = (v: MailView) => { setView(v); setOpen(null); setMenu(false); setSelected(new Set()); setCursor(null); setPerson(null); };
  // Keyboard and selection: the highlighted row, the selected threads, the "?" list, Snooze for several.
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState(false);
  const [composing, setComposing] = useState(false);
  // The phone layout's search: a button that opens a search field across the bar (open while a search is typed).
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = () => { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); };
  const closeSearch = () => { setQ(""); setSearchOpen(false); };
  const [multiSnooze, setMultiSnooze] = useState(false);
  const anchor = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Refresh, in the top bar: its result shows at the top of the list for a few seconds.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!refreshMsg) return;
    const t = setTimeout(() => setRefreshMsg(null), 6000);
    return () => clearTimeout(t);
  }, [refreshMsg]);
  const refresh = async () => {
    const client = engine.client;
    if (!client) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const r = await client.mailRefresh();
      const kept = r.mailboxes.reduce((n, m) => n + ("kept" in m ? m.kept : 0), 0);
      const failed = r.mailboxes.filter((m) => "error" in m).length;
      setRefreshMsg(failed ? { ok: false, text: `${failed === 1 ? "A mailbox" : `${failed} mailboxes`} could not be refreshed. The i at the bottom of the side list has why.` } : { ok: true, text: kept ? `${kept} new.` : "Nothing new." });
      await list.reload();
    } catch (e) {
      setRefreshMsg({ ok: false, text: plainError(e) });
    } finally {
      setRefreshing(false);
    }
  };
  const toggleBundle = (id: string) => setOpenBundles((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const here = view.startsWith("b:") ? shown.find((b) => b.id === view.slice(2)) : null;
  const folder = view.startsWith("f:") ? list.data?.folders?.find((f) => f.key === view.slice(2)) : undefined;
  const title = folder ? folderLabel(folder) : here?.name ?? (view === "snoozed" ? "Snoozed" : view === "done" ? "Done" : "Inbox");
  const barClass = folder ? "v-folder" : here ? bundleClass(here) : `v-${view}`;
  const [actErr, setActErr] = useState("");
  // The last Done or Sweep, for its Undo bar (gone after a few seconds, or with the next one).
  const [undo, setUndo] = useState<{ text: string; run: () => Promise<void> } | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 10_000);
    return () => clearTimeout(t);
  }, [undo]);
  const move: LookValue["move"] = async (ids, to) => {
    const c = engine.client;
    if (!c || !ids.length) return;
    setActErr("");
    try {
      // A selection of any size: the hub takes 500 at a time.
      const r: { moved: string[]; error?: string } = { moved: [] };
      for (const part of batches(ids)) {
        const one = to === "done" ? await c.mailDone(part) : await c.mailUndo(part);
        r.moved.push(...one.moved);
        if (one.error) { r.error = one.error; break; }
      }
      if (r.error) setActErr(r.error);
      if (r.moved.length && to === "done") {
        const ids2 = r.moved;
        setUndo({ text: r.moved.length === 1 ? "Marked done" : `${r.moved.length} marked done`, run: () => move(ids2, "inbox") });
        if (open && r.moved.includes(open)) setOpen(null);
      } else if (to === "inbox") setUndo(null);
    } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };
  const relocate: LookValue["relocate"] = async (ids, to, said, back) => {
    const c = engine.client;
    if (!c || !ids.length) return;
    setActErr("");
    try {
      const moved: string[] = [];
      const kept: string[] = [];
      let error: string | undefined;
      for (const part of batches(ids)) {
        const one = await c.mailMove(part, to);
        moved.push(...one.moved);
        kept.push(...one.moved.map((id) => one.to[id]).filter((x): x is string => !!x));
        if (one.error) { error = one.error; break; }
      }
      if (error) setActErr(error);
      if (moved.length) {
        if (open && moved.includes(open)) setOpen(null);
        setSelected(new Set());
        // Undo only where the mail can go back, and only for mail the hub knows the new place of.
        if (back && kept.length) setUndo({ text: moved.length === 1 ? said : `${moved.length} ${said.charAt(0).toLowerCase()}${said.slice(1)}`, run: () => relocate(kept, back, "Moved back", null) });
        else setUndo(null);
      }
    } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };
  const unsnooze: LookValue["unsnooze"] = async (m) => {
    setActErr("");
    try { await engine.client?.mailUnsnooze(m.id); } catch (e) { setActErr(plainError(e)); }
    setSnoozeFor(null);
    await list.reload();
  };
  const snooze: LookValue["snooze"] = async (m, until) => {
    const c = engine.client;
    if (!c) return;
    setActErr("");
    try {
      await c.mailSnooze(m.id, until.toISOString());
      setSnoozeFor(null);
      if (open === m.id) setOpen(null);
      setUndo({ text: `Snoozed until ${until.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`, run: () => unsnooze(m) });
    } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };
  const act: LookValue["act"] = async (run) => {
    if (!engine.client) return;
    setActErr("");
    try { await run(engine.client); } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };

  // The rows in the order shown, for the arrow keys: threads, and a bundle's row (with its threads while it is open).
  const navItems = useMemo(() => {
    if (!list.data || editing) return [];
    if (view !== "inbox") return viewMessages(messages, view, shown).map((m) => m.id);
    const out: string[] = pinnedOnly || q.trim() ? [] : reminders.map((r) => `rem:${r.id}`);
    for (const s of inboxSections(messages, shown, { pinnedOnly, delivery })) {
      for (const r of s.rows) {
        if (r.kind === "mail") { out.push(r.mail.id); continue; }
        const key = `${s.title}:${r.bundle.id}`;
        out.push(`bundle:${key}`);
        if (openBundles.has(key)) out.push(...r.mails.map((m) => m.id));
      }
    }
    return out;
  }, [list.data, editing, view, messages, shown, pinnedOnly, delivery, openBundles, reminders, q]);
  const byId = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const pick: LookValue["pick"] = (id, range) => {
    setSelected((s) => {
      const n = new Set(s);
      const from = anchor.current ? navItems.indexOf(anchor.current) : -1;
      const to = navItems.indexOf(id);
      if (range && from >= 0 && to >= 0) {
        for (const x of navItems.slice(Math.min(from, to), Math.max(from, to) + 1)) if (byId.has(x)) n.add(x);
      } else if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
    anchor.current = id;
  };
  const chosen = [...selected].map((id) => byId.get(id)).filter((t): t is MailThread => !!t);
  // What D, S, P, U and R act on: the selection, else the open thread, else the highlighted one.
  const targets = (): MailThread[] => chosen.length ? chosen : [open ? byId.get(open) : cursor ? byId.get(cursor) : undefined].filter((t): t is MailThread => !!t);
  const doneAll = async (ts: MailThread[]) => {
    const back = view === "done";
    await move(ts.flatMap((t) => (back ? t.ids.done : t.ids.open)), back ? "inbox" : "done");
    setSelected(new Set());
  };
  const pinAll = (ts: MailThread[]) => { const to = !ts.every((t) => t.pinned); void act(async (c) => { for (const t of ts) await c.mailPin(t.id, to); }); };
  const readAll = (ts: MailThread[], read: boolean) => {
    if (!read && open && ts.some((t) => t.id === open)) setOpen(null);
    void act(async (c) => { for (const part of batches(ts.flatMap((t) => (read ? t.ids.unread : [t.id])))) await c.mailSeenMany(part, read); });
  };
  const snoozeAll = async (ts: MailThread[], until: Date) => {
    const c = engine.client;
    if (!c) return;
    setActErr("");
    try { for (const t of ts) await c.mailSnooze(t.id, until.toISOString()); } catch (e) { setActErr(plainError(e)); }
    setUndo({ text: `${ts.length} snoozed until ${until.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`, run: async () => { for (const t of ts) await engine.client?.mailUnsnooze(t.id); await list.reload(); } });
    setSelected(new Set());
    setMultiSnooze(false);
    await list.reload();
  };

  // The keys, before the app's own one-letter keys (this listens first, in the capture phase, and keeps the keys it uses).
  const onKey = (a: MailKey, target: EventTarget | null): boolean => {
    const at = cursor ? navItems.indexOf(cursor) : -1;
    const moveTo = (i: number, extend: boolean) => {
      const next = navItems[Math.max(0, Math.min(navItems.length - 1, i))];
      if (!next) return;
      if (extend) setSelected((s) => new Set([...s, ...[cursor, next].filter((x): x is string => !!x && byId.has(x))]));
      setCursor(next);
    };
    switch (a) {
      case "escape":
        if (isTypingTarget(target)) { (target as HTMLElement).blur(); return true; }
        if (help) { setHelp(false); return true; }
        if (multiSnooze) { setMultiSnooze(false); return true; }
        if (snoozeFor) { setSnoozeFor(null); return true; }
        if (open) { setOpen(null); return true; }
        if (selected.size) { setSelected(new Set()); return true; }
        return false;
      case "down": case "extend-down": moveTo(at < 0 ? 0 : at + 1, a === "extend-down"); return true;
      case "up": case "extend-up": moveTo(at < 0 ? 0 : at - 1, a === "extend-up"); return true;
      case "open":
        if (!cursor) return false;
        if (cursor.startsWith("rem:")) break;
        if (cursor.startsWith("bundle:")) toggleBundle(cursor.slice(7)); else setOpen(open === cursor ? null : cursor);
        return true;
      case "select": if (!cursor || !byId.has(cursor)) return false; pick(cursor, false); return true;
      case "search": searchRef.current?.focus(); return true;
      case "help": setHelp((h) => !h); return true;
    }
    // A reminder row: Enter opens it in Tasks, D marks it done, S shows its snooze choices.
    if (cursor?.startsWith("rem:") && !chosen.length && !open) {
      const r = tasks.find((t) => t.id === cursor.slice(4));
      if (!r) return false;
      if (a === "open") { window.location.hash = `#/tasks?focus=${encodeURIComponent(r.id)}`; return true; }
      if (a === "done") { void completeTask(r); return true; }
      if (a === "snooze") { setRemindFor(remindFor === r.id ? null : r.id); return true; }
      return false;
    }
    const ts = targets();
    if (!ts.length) return false;
    if (a === "done") void doneAll(ts);
    else if (a === "pin") pinAll(ts);
    else if (a === "read" || a === "unread") readAll(ts, a === "read");
    else if (a === "delete") void relocate(ts.flatMap(threadIds), "trash", "Moved to Trash", "inbox");
    else if (a === "spam") void relocate(ts.flatMap(threadIds), "junk", "Moved to Spam", "inbox");
    else if (a === "snooze") {
      if (ts.length > 1) setMultiSnooze(true);
      else if (ts[0].state !== "done") { setOpen(ts[0].id); setSnoozeFor(ts[0].id); }
    }
    return true;
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!window.matchMedia("(min-width: 768px)").matches) return;
      // Enter and Space on a button, link or field that has the focus are that control's own.
      const on = e.target instanceof Element ? e.target.closest("button, a[href], summary, select, input, textarea, [role='button']") : null;
      if (on && (e.key === "Enter" || e.key === " ")) return;
      const a = mailKeyAction(e, isTypingTarget(e.target));
      if (a && keyRef.current(a, e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
  // The highlighted row stays in view.
  useEffect(() => {
    if (cursor) document.querySelector(`[data-nav="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <Look.Provider value={{ logos: list.data?.logos ?? {}, shown, act, move, snooze, unsnooze, snoozeFor, setSnoozeFor, openMail: (id) => setOpen(id), relocate, folders: list.data?.folders ?? [], showPerson: (who) => { setPerson(who); setOpen(null); setMenu(false); }, showInPlace: (h) => { setPerson(null); setQ(""); setSearchOpen(false); setView(h.where === "snoozed" ? "snoozed" : h.where === "done" ? "done" : "inbox"); setOpen(byId.has(h.id) ? h.id : [...byId.values()].find((t) => t.members.some((x) => x.id === h.id))?.id ?? null); }, snoozeTimes: list.data?.snooze_times ?? SNOOZE_DEFAULTS, delivery, notifyOn: list.data?.mail_notify ?? NOTIFY_DEFAULTS, cursor, selected, pick }}>
    <div className={`mailx${menu ? " menu-open" : ""}${selected.size ? " selecting" : ""}`}>
      <div className={`mailx-bar ${barClass}${chosen.length ? " selecting" : ""}${searchOpen || q ? " search-open" : ""}`}>
        <div className="mailx-bar-left">
        <button type="button" className="mailx-menu" aria-label="Show Inbox, Snoozed, Done and the bundles" aria-expanded={menu} onClick={() => setMenu((x) => !x)}>
          <Icon name="menu" />
        </button>
        {chosen.length ? (
          <div className="mailx-selbar" role="toolbar" aria-label="Selected mail">
            <h1>{chosen.length} selected</h1>
            <button type="button" onClick={() => void doneAll(chosen)}><Icon name={view === "done" ? "inbox" : "check"} /><span>{view === "done" ? "Move to Inbox" : "Done"}</span></button>
            {view !== "done" && <button type="button" onClick={() => setMultiSnooze((x) => !x)}><Icon name="clock" /><span>Snooze</span></button>}
            <button type="button" onClick={() => pinAll(chosen)}><Icon name="pin" /><span>{chosen.every((t) => t.pinned) ? "Unpin" : "Pin"}</span></button>
            <button type="button" onClick={() => readAll(chosen, true)}><span>Mark read</span></button>
            <button type="button" onClick={() => readAll(chosen, false)}><span>Mark unread</span></button>
            <button type="button" onClick={() => void relocate(chosen.flatMap(threadIds), "trash", "Moved to Trash", "inbox")}><Icon name="trash" /><span>Delete</span></button>
            <button type="button" onClick={() => void relocate(chosen.flatMap(threadIds), "junk", "Moved to Spam", "inbox")}><Icon name="spam" /><span>Spam</span></button>
            <button type="button" className="mailx-selclear" onClick={() => { setSelected(new Set()); setMultiSnooze(false); }} aria-label="Clear the selection">✕</button>
          </div>
        ) : <h1>{title}</h1>}
        </div>
        {!chosen.length && (
          <div className="mailx-bar-mid">
            <button type="button" className={`mailx-refresh${refreshing ? " busy" : ""}`} aria-label={refreshing ? "Refreshing" : "Refresh"} title="Refresh" disabled={refreshing || !engine.client} onClick={() => void refresh()}>
              <Icon name="refresh" />
            </button>
            <button type="button" className="mailx-search-btn" aria-label="Search mail" title="Search mail" onClick={openSearch}><Icon name="search" /></button>
            <input ref={searchRef} type="search" className="mailx-search" placeholder="Search mail" aria-label="Search mail" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => { if (!q) setSearchOpen(false); }} />
            <button type="button" className="mailx-search-close" aria-label="Close the search" title="Close the search" onClick={closeSearch}>✕</button>
            {/* Only the Inbox has it; elsewhere an unseen stand-in of its size keeps the search box in the same place. */}
            <button type="button" className={`mailx-switch${view === "inbox" ? "" : " placeholder"}`} aria-pressed={pinnedOnly} aria-label="Pinned only" title="Pinned only" aria-hidden={view !== "inbox" || undefined} tabIndex={view === "inbox" ? undefined : -1} onClick={() => setPinnedOnly((x) => !x)}>
              <span className="sw" aria-hidden="true"><span className="knob"><Icon name="pin" /></span></span>
            </button>
          </div>
        )}
        {!chosen.length && (
          <div className="mailx-bar-right">
            <button type="button" className="mailx-compose-btn" aria-expanded={composing} onClick={() => setComposing((x) => !x)} title="Write a new mail, saved to Drafts in iCloud"><Icon name="pencil" /><span>New mail</span></button>
          </div>
        )}
      </div>
      <div className="mailx-body">
        <nav className="mailx-rail" aria-label="Mail views">
          <Nav view="inbox" current={view} go={go} icon="inbox" label="Inbox" count={threads.filter((m) => m.state === "inbox" && isUnread(m) && inboxAt(m, delivery)).length} />
          <Nav view="snoozed" current={view} go={go} icon="clock" label="Snoozed" count={threads.filter((m) => m.state === "snoozed").length} />
          <Nav view="done" current={view} go={go} icon="check" label="Done" />
          {/* The other folders, between Done and the bundles: Drafts, Sent, Spam, Trash, then the owner's own. */}
          {(list.data?.folders ?? []).map((f) => <FolderNav key={f.key} f={f} current={view} go={go} many={(list.data?.mailboxes.length ?? 0) > 1} />)}
          <div className="mailx-label">Bundles</div>
          {shown.filter((b) => !b.module && b.custom === undefined).map((b) => <BundleNav key={b.id} b={b} current={view} go={(v) => { setEditing(null); go(v); }} threads={threads} />)}
          {shown.some((b) => b.module) && <div className="mailx-label">From your modules</div>}
          {shown.filter((b) => b.module).map((b) => <BundleNav key={b.id} b={b} current={view} go={(v) => { setEditing(null); go(v); }} threads={threads} />)}
          <div className="mailx-label">Your bundles</div>
          {shown.filter((b) => b.custom !== undefined).map((b) => <BundleNav key={b.id} b={b} current={view} go={(v) => { setEditing(null); go(v); }} threads={threads} />)}
          <button type="button" className="mailx-nav mailx-newbundle" onClick={() => { setEditing("new"); setMenu(false); }}><span className="ico"><Icon name="plus" /></span>New bundle</button>
          {list.data && <Mailboxes data={list.data} showKeys={() => setHelp(true)} />}
        </nav>
        {menu && <div className="mailx-scrim" onClick={() => setMenu(false)} aria-hidden="true" />}
        <div className="mailx-main">
          {actErr && <div className="error mailx-acterr" role="alert">{actErr}</div>}
          {composing && <Composer close={() => setComposing(false)} />}
          {refreshMsg && <div className={`small mailx-refreshmsg ${refreshMsg.ok ? "ok" : "error"}`} role="status">{refreshMsg.text}</div>}
          {help && (
            <div className="mailx-help" role="dialog" aria-label="Keyboard keys">
              <b>Keyboard keys</b>
              <dl>{MAIL_KEYS.map((k) => <Fragment key={k.keys}><dt>{k.keys}</dt><dd>{k.does}</dd></Fragment>)}</dl>
              <button type="button" className="link" onClick={() => setHelp(false)}>Close</button>
            </div>
          )}
          {multiSnooze && chosen.length > 0 && <MultiSnooze count={chosen.length} pick={(until) => void snoozeAll(chosen.filter((t) => t.state !== "done"), until)} close={() => setMultiSnooze(false)} />}
          {undo && (
            <div className="mailx-undo" role="status">
              <span>{undo.text}</span>
              <button type="button" onClick={() => { const run = undo.run; setUndo(null); void run(); }}>Undo</button>
            </div>
          )}
          {!list.data && list.error ? <div className="error">{list.error}</div>
            : !list.data ? <div className="muted small">Loading</div>
            : !list.data.mailboxes.length ? <div className="empty">Link an iCloud mailbox in <a href="#/settings/connections">Settings, Connections</a> to see your mail here.</div>
            : editing
              ? <BundleForm key={editing === "new" ? "new" : editing.id} start={editing === "new" ? null : editing} close={() => setEditing(null)}
                  saved={async (id) => { setEditing(null); await list.reload(); if (id) go(`b:${id}` as MailView); else go("inbox"); }} />
            : person
              ? <HitList key={person.address} title={`With ${personLabel(person)}`} sub={person.address} q="" person={person.address} stamp={list.data} close={() => setPerson(null)} />
            : folder
              ? <FolderView key={folder.key} f={folder} q={q} stamp={list.data} open={open} setOpen={setOpen} />
            : view === "inbox"
              ? <InboxList reminders={pinnedOnly || q.trim() ? [] : reminders} tasks={tasks} remindFor={remindFor} setRemindFor={setRemindFor} messages={messages} shown={shown} delivery={delivery} pinnedOnly={pinnedOnly} open={open} setOpen={setOpen} openBundles={openBundles} toggleBundle={toggleBundle} searching={!!q.trim()} waiting={!list.data.mailboxes.some((m) => m.last_refresh)} />
              : <Flat messages={viewMessages(messages, view, shown)} view={view} bundle={here ?? null} open={open} setOpen={setOpen}
                  edit={here?.custom !== undefined ? () => setEditing(list.data?.custom_bundles?.find((c) => c.id === here.id) ?? null) : undefined} />}
          {/* Typing a search: beside the view's own matches, every kept mail's (whole texts, folders too). */}
          {!person && !editing && !!list.data?.mailboxes.length && q.trim().length >= 3 && <HitList key="everywhere" title="In all your mail" q={q.trim()} stamp={list.data} />}
          {list.data?.mailboxes.some((m) => m.more) && <div className="muted small mailx-hint">Bringing in more of your Inbox. The rest arrives over the next few minutes.</div>}
        </div>
      </div>
    </div>
    </Look.Provider>
  );
}

function Nav({ view, current, go, icon, label, count }: { view: MailView; current: MailView; go: (v: MailView) => void; icon: string; label: string; count?: number }) {
  return (
    <button type="button" className={`mailx-nav v-${view}`} aria-current={current === view ? "page" : undefined} onClick={() => go(view)}>
      <span className="ico"><Icon name={icon} /></span>{label}{!!count && <span className="n">{count}</span>}
    </button>
  );
}

/**
 * Search hits from the hub (GET /mail/search): every kept mail with the search's words, or all mail with one person.
 * Each row says where the mail is; opened, it shows whole, with Show it in its place for the Inbox, Snoozed and Done.
 * Asked again a moment after the search stops changing, and with each list.
 */
function HitList({ title, sub, q, person, stamp, close }: { title: string; sub?: string; q: string; person?: string; stamp: unknown; close?: () => void }) {
  const { showPerson, showInPlace } = useContext(Look);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      engine.client?.mailSearch(q, person ?? "").then((r) => { if (live) { setHits(r.hits); setErr(""); } }).catch((e) => { if (live) setErr(plainError(e)); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q, person, stamp]);
  const mineTo = (h: SearchHit) => (h.mine || h.where === "drafts") && h.to?.length;
  return (
    <section className="mailx-col mailx-hits" aria-label={title}>
      <h2 className="mailx-hits-head">
        <span>{title}{hits ? ` (${hits.length}${hits.length >= 200 ? "+" : ""})` : ""}</span>
        {sub && <span className="muted small">{sub}</span>}
        {close && <button type="button" className="link small" onClick={close}>Close</button>}
      </h2>
      {err ? <div className="error">{err}</div> : !hits ? <div className="muted small">Searching</div> : !hits.length ? <div className="muted small">Nothing found.</div> : (
        <div className="mailx-list">
          {hits.map((h) => open === h.id ? (
            <article key={h.id} className="mailx-card">
              <button type="button" className="mailx-card-head" onClick={() => setOpen(null)} aria-expanded="true">
                <span className="mailx-av" aria-hidden="true">{initials(h.from)}</span>
                <span className="mailx-what">
                  <span className="subject">{h.subject || "(no subject)"}</span>
                  <span className="meta"><b>{personLabel(h.from)}</b> &lt;{h.from.address}&gt; · {fmtDateTime(h.at)} · {whereLabel(h)}</span>
                </span>
              </button>
              <div className="mailx-card-acts mailx-card-pad">
                {(h.where === "inbox" || h.where === "snoozed" || h.where === "done") && <button type="button" className="mailx-act" onClick={() => showInPlace(h)}><Icon name="inbox" /><span>Show it in its place</span></button>}
                {!h.mine && !person && <button type="button" className="mailx-act" onClick={() => showPerson(h.from)}><Icon name="person" /><span>All mail with {personLabel(h.from).split(/\s+/)[0]}</span></button>}
              </div>
              <Message m={h} />
            </article>
          ) : (
            <div key={h.id} className="mailx-item">
              <button type="button" className="mailx-row" onClick={() => setOpen(h.id)}>
                <span className="mailx-dotcol" />
                <span className="mailx-av" aria-hidden="true">{initials(mineTo(h) ? h.to![0] : h.from)}</span>
                <span className="mailx-what">
                  <span className="who"><b>{mineTo(h) ? `To: ${h.to!.map(personLabel).join(", ")}` : personLabel(h.from)}</b><span className="chip">{whereLabel(h)}</span></span>
                  <span className="line"><span className="subj">{h.subject || "(no subject)"}</span>{h.snippet && <> · {h.snippet}</>}</span>
                </span>
                <span className="when">{whenLabel(h.at)}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** A folder in the side list: its icon, its name, and its drafts or unread mail. */
function FolderNav({ f, current, go, many }: { f: MailFolder; current: MailView; go: (v: MailView) => void; many: boolean }) {
  const view = `f:${f.key}` as MailView;
  const n = folderCount(f);
  return (
    <button type="button" className="mailx-nav v-folder" aria-current={current === view ? "page" : undefined} onClick={() => go(view)}>
      <span className="ico"><Icon name={FOLDER_ICONS[f.role]} /></span>{folderLabel(f, many)}{!!n && <span className="n">{n}</span>}
    </button>
  );
}

/**
 * One of the other folders: its kept mail, newest first, each opening as in the Inbox (its own words, the page as sent
 * without web pictures). Read-only: nothing here moves, marks or changes mail. Fetched again with each list (`stamp`).
 */
function FolderView({ f, q, stamp, open, setOpen }: { f: MailFolder; q: string; stamp: unknown; open: string | null; setOpen: (id: string | null) => void }) {
  const [mails, setMails] = useState<FolderMail[] | null>(null);
  const [err, setErr] = useState("");
  const [shown, setShown] = useState(100);
  useEffect(() => {
    let live = true;
    engine.client?.mailFolder(f.key).then((r) => { if (live) { setMails(r.messages); setErr(""); } }).catch((e) => { if (live) setErr(plainError(e)); });
    return () => { live = false; };
  }, [f.key, stamp]);
  if (err) return <div className="error">{err}</div>;
  if (!mails) return <div className="muted small">Loading</div>;
  const hits = q.trim() ? mails.filter((m) => matches(m, q)) : mails;
  if (!hits.length) return <Empty title={q.trim() ? "No mail matches" : `Nothing in ${folderLabel(f)}`} text={f.role === "junk" ? "Mail iCloud takes for spam gathers here." : "Mail in this folder in iCloud shows here."} />;
  return (
    <div className="mailx-col">
      {f.role === "junk" && <div className="muted small mailx-folder-note">iCloud put this mail in Spam. Its pictures are never loaded, and its links may not be safe.</div>}
      {f.role === "drafts" && <div className="muted small mailx-folder-note">Send or change a draft in Apple Mail.</div>}
      <div className="mailx-list">
        {hits.slice(0, shown).map((m) => open === m.id
          ? <FolderCard key={m.id} m={m} f={f} close={() => setOpen(null)} />
          : (
            <div key={m.id} className="mailx-item">
              <button type="button" className={`mailx-row${m.seen ? "" : " unread"}`} onClick={() => setOpen(m.id)}>
                <span className="mailx-dotcol">{!m.seen && <span className="mailx-dot" title="Unread" />}</span>
                <span className="mailx-av" aria-hidden="true">{initials(m.folder_role === "sent" || m.folder_role === "drafts" ? m.to[0] ?? m.from : m.from)}</span>
                <span className="mailx-what">
                  <span className="who"><b>{folderWho(m)}</b>{!!m.attachments && <span className="clipmark" title={m.attachments === 1 ? "An attachment" : `${m.attachments} attachments`}><Icon name="clip" /></span>}</span>
                  <span className="line"><span className="subj">{m.subject || "(no subject)"}</span>{m.preview && <> · {m.preview}</>}</span>
                </span>
                <span className="when">{whenLabel(m.at)}</span>
              </button>
            </div>
          ))}
      </div>
      {hits.length > shown && <button type="button" className="mailx-more" onClick={() => setShown((n) => n + 100)}>Show more ({hits.length - shown})</button>}
    </div>
  );
}

/** A folder's mail open: its sender (and for what the owner wrote, who it went to), then the message as in the Inbox. */
function FolderCard({ m, f, close }: { m: FolderMail; f: MailFolder; close: () => void }) {
  const [forwarding, setForwarding] = useState(false);
  const [editing, setEditing] = useState(false);
  const mine = m.folder_role === "sent" || m.folder_role === "drafts";
  return (
    <article className="mailx-card">
      <button type="button" className="mailx-card-head" onClick={close} aria-expanded="true">
        <span className="mailx-av" aria-hidden="true">{initials(mine ? m.to[0] ?? m.from : m.from)}</span>
        <span className="mailx-what">
          <span className="subject">{m.subject || "(no subject)"}</span>
          <span className="meta">{mine ? <>To {m.to.map((a) => `${personLabel(a)} <${a.address}>`).join(", ") || "no one yet"}</> : <><b>{personLabel(m.from)}</b> &lt;{m.from.address}&gt;</>} · {fmtDateTime(m.at)}</span>
        </span>
      </button>
      <div className="mailx-card-acts mailx-card-pad"><FolderActions m={m} f={f} />
        <button type="button" className={`mailx-act${forwarding ? " on" : ""}`} aria-expanded={forwarding} onClick={() => { setForwarding((x) => !x); setEditing(false); }}><Icon name="forward" /><span>Forward</span></button>
        {f.role === "drafts" && <button type="button" className={`mailx-act${editing ? " on" : ""}`} aria-expanded={editing} onClick={() => { setEditing((x) => !x); setForwarding(false); }}><Icon name="pencil" /><span>Edit</span></button>}
      </div>
      {forwarding && <Composer forward={m} close={() => setForwarding(false)} />}
      {editing && <Composer draft={{ m, email: f.email }} close={() => setEditing(false)} />}
      {m.folder_role === "junk" && <div className="warn small mailx-card-pad">This mail is in Spam. Be careful with its links, and never sign in or pay through them.</div>}
      <Message m={m} />
    </article>
  );
}

function BundleNav({ b, current, go, threads }: { b: Bundle; current: MailView; go: (v: MailView) => void; threads: MailThread[] }) {
  const view = `b:${b.id}` as MailView;
  const n = threads.filter((m) => m.state === "inbox" && m.bundle === b.id && isUnread(m)).length;
  return (
    <button type="button" className={`mailx-nav ${bundleClass(b)}`} aria-current={current === view ? "page" : undefined} onClick={() => go(view)}>
      <span className="ico"><Icon name={b.custom !== undefined ? "own" : b.id} /></span>{b.name}{!!n && <span className="n">{n}</span>}
    </button>
  );
}

/** Notifications for new mail from people, and what they say (a bundle's switch is in its own view). */
function NotifySettings() {
  const { notifyOn, act } = useContext(Look);
  return (
    <div className="mailx-notify small">
      <label><input type="checkbox" checked={notifyOn.people} onChange={(e) => void act((c) => c.mailNotify({ people: e.target.checked }))} /> Notify me of mail from people</label>
      <label>Notifications show
        <select value={notifyOn.detail} onChange={(e) => void act((c) => c.mailNotify({ detail: e.target.value as MailNotify["detail"] }))}>
          <option value="full">sender and subject</option>
          <option value="sender">sender only</option>
          <option value="count">only a count</option>
        </select>
      </label>
    </div>
  );
}

/** Each mailbox's last refresh or problem, and Refresh. */
/**
 * The bottom of the side list: Keyboard keys, and an info button that opens the rest (each mailbox's last refresh,
 * what changes in iCloud, notifications). A mailbox's problem puts a dot on the info button. Refresh is in the top bar.
 */
function Mailboxes({ data, showKeys }: { data: MailList; showKeys: () => void }) {
  const [info, setInfo] = useState(false);
  const trouble = data.mailboxes.some((m) => m.last_error);
  return (
    <div className="mailx-boxes small">
      <div className="row">
        <button type="button" className="small mailx-keysbtn" onClick={showKeys}>Keyboard keys</button>
        <button type="button" className="small mailx-infobtn" aria-expanded={info} aria-label={trouble ? "Mailboxes and settings (a mailbox has a problem)" : "Mailboxes and settings"} title="Mailboxes and settings" onClick={() => setInfo(!info)}>
          i{trouble && <span className="mailx-alertdot" />}
        </button>
      </div>
      {info && (
        <div className="mailx-info">
          {data.mailboxes.map((m) => (
            <div key={m.email}>
              <span className="muted">{m.email}: {m.last_refresh ? `refreshed ${fmtDateTime(m.last_refresh)}` : "not refreshed yet"}</span>
              {m.last_error && <div className="error">{m.last_error}</div>}
            </div>
          ))}
          <div className="muted">Opening a mail marks it read in iCloud too, and Pin flags it there (a flag in Apple Mail pins it here); Done moves it to Archive there, and Undo moves it back.</div>
          <NotifySettings />
          <BlockedList blocked={data.blocked ?? []} />
        </div>
      )}
    </div>
  );
}

/** The blocked senders (their mail goes to Spam), each with Unblock. */
function BlockedList({ blocked }: { blocked: string[] }) {
  const { act } = useContext(Look);
  if (!blocked.length) return null;
  return (
    <div className="mailx-blocked">
      <b>Blocked senders</b>
      <span className="muted">Their mail goes to Spam.</span>
      {blocked.map((b) => <div key={b} className="row"><span>{b}</span><button type="button" className="link small" onClick={() => void act((c) => c.mailUnblock(b))}>Unblock</button></div>)}
    </div>
  );
}

function InboxList({ reminders, tasks, remindFor, setRemindFor, messages, shown, delivery, pinnedOnly, open, setOpen, openBundles, toggleBundle, searching, waiting }: {
  reminders: DueReminder[]; tasks: Entity[]; remindFor: string | null; setRemindFor: (id: string | null) => void;
  messages: MailThread[]; shown: Bundle[]; delivery: Record<string, BundleDelivery>; pinnedOnly: boolean; open: string | null; setOpen: (id: string | null) => void;
  openBundles: Set<string>; toggleBundle: (id: string) => void; searching: boolean; waiting: boolean;
}) {
  const sections = inboxSections(messages, shown, { pinnedOnly, delivery });
  // Due reminders lead "Today" (a "Today" of their own when no mail came today).
  if (reminders.length && sections[0]?.title !== "Today") sections.unshift({ title: "Today", rows: [] });
  const reminderRows = reminders.map((r) => <ReminderRow key={`rem:${r.id}`} r={r} task={tasks.find((t) => t.id === r.id)} picking={remindFor === r.id} setPicking={(on) => setRemindFor(on ? r.id : null)} />);
  if (!sections.length) {
    if (searching) return <div className="muted small">No mail has all of those words.</div>;
    if (waiting) return <div className="empty">Your Inbox arrives with the first refresh, a minute or so after the hub starts. Refresh brings it now.</div>;
    return <Empty title={pinnedOnly ? "No pinned mail" : "You're all done"} text={pinnedOnly ? "Pinned mail stays here." : "Nothing left in your Inbox."} />;
  }
  return (
    <div className="mailx-col">
      {sections.map((s, i) => (
        <section key={s.title} className="mailx-group">
          <h2>{s.title}<Sweep mails={s.rows.flatMap((r) => (r.kind === "mail" ? [r.mail] : r.mails))} /></h2>
          <div className="mailx-list">
            {i === 0 && reminderRows}
            {s.rows.map((r) => r.kind === "mail"
              ? <Row key={r.mail.id} m={r.mail} open={open === r.mail.id} setOpen={setOpen} />
              : <BundleRow key={`${s.title}:${r.bundle.id}`} nav={`bundle:${s.title}:${r.bundle.id}`} b={r.bundle} mails={r.mails} isOpen={openBundles.has(`${s.title}:${r.bundle.id}`)} toggle={() => toggleBundle(`${s.title}:${r.bundle.id}`)} open={open} setOpen={setOpen} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * A reminder that is due, among the mail: its title and when it came due; Done marks the task done, Snooze moves its
 * time (a task that asks why, asks here too), and it opens in Tasks.
 */
function ReminderRow({ r, task, picking, setPicking }: { r: DueReminder; task: Entity | undefined; picking: boolean; setPicking: (on: boolean) => void }) {
  const { cursor, snoozeTimes } = useContext(Look);
  const [err, setErr] = useState("");
  const snooze = async (until: Date) => {
    if (!task) return;
    let reason: string | undefined;
    if (r.friction !== "none") {
      reason = window.prompt(`Why snooze "${r.title}"?`) ?? undefined;
      if (!reason?.trim()) return;
    }
    try { await snoozeReminder(task, until.toISOString(), reason); setPicking(false); } catch (e) { setErr(plainError(e)); }
  };
  return (
    <div className={`mailx-item reminder${cursor === `rem:${r.id}` ? " cursor" : ""}`} data-nav={`rem:${r.id}`}>
      <a className="mailx-row" href={`#/tasks?focus=${encodeURIComponent(r.id)}`}>
        <span className="mailx-dotcol" />
        <span className="mailx-av reminder" aria-hidden="true"><Icon name="bell" /></span>
        <span className="mailx-what">
          <span className="who"><b>{r.title}</b></span>
          <span className="line">Reminder</span>
        </span>
        <span className="when">{whenLabel(r.at)}</span>
      </a>
      <span className="mailx-acts">
        <button type="button" className="mailx-act" title="Snooze the reminder" aria-label="Snooze" onClick={() => setPicking(!picking)}><Icon name="clock" /></button>
        <button type="button" className="mailx-act" title="Done: marks the task done" aria-label="Done" onClick={() => task && void completeTask(task).catch((e) => setErr(plainError(e)))}><Icon name="check" /></button>
      </span>
      {picking && (
        <div className="mailx-snooze mailx-remsnooze">
          {snoozeChoices(new Date(), snoozeTimes).map((c) => (
            <button key={c.id} type="button" className="mailx-snooze-choice" onClick={() => void snooze(c.at)}>
              <b>{c.label}</b><span>{c.at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
            </button>
          ))}
        </div>
      )}
      {err && <div className="error small mailx-card-pad">{err}</div>}
    </div>
  );
}

function Flat({ messages, view, bundle, open, setOpen, edit }: { messages: MailThread[]; view: MailView; bundle: Bundle | null; open: string | null; setOpen: (id: string | null) => void; edit?: () => void }) {
  const editButton = edit && <button type="button" className="mailx-act mailx-editbundle" onClick={edit}><Icon name="pencil" /><span>Edit bundle</span></button>;
  // The Trips bundle: each trip's mail as one box, then the mail in no trip as rows.
  const trips = bundle?.id === "trips" ? tripsOf(messages) : [];
  const inTrips = new Set(trips.flatMap((t) => t.parts.map((p) => p.mail.id)));
  const rest = messages.filter((m) => !inTrips.has(m.id));
  if (!messages.length) {
    if (view === "snoozed") return <Empty title="Nothing snoozed" text="Snoozed mail waits here until its time." />;
    if (view === "done") return <Empty title="Nothing done yet" text="Mail you mark done shows here." />;
    return <div className="mailx-col">{bundle && <ModuleLink b={bundle} />}{editButton}{bundle && <DeliveryControl b={bundle} mails={messages} />}<Empty title={`No ${bundle?.name.toLowerCase() ?? ""} mail`} text="New mail of this kind gathers here." /></div>;
  }
  return (
    <div className="mailx-col">
      {bundle && <ModuleLink b={bundle} />}
      {editButton}
      {bundle && <DeliveryControl b={bundle} mails={messages} />}
      {trips.map((t) => <TripBox key={t.id} t={t} open={open} setOpen={setOpen} />)}
      {rest.length > 0 && (
        <div className="mailx-list">
          {rest.map((m) => <Row key={m.id} m={m} open={open === m.id} setOpen={setOpen} />)}
        </div>
      )}
    </div>
  );
}

/**
 * A trip as one box (the Trips bundle): its name and days, then its pieces in time order (the flight out, the hotel,
 * the flight back), each opening its own mail in the box. A mail with two pieces (out and back) opens from either.
 */
function TripBox({ t, open, setOpen }: { t: Trip<MailThread>; open: string | null; setOpen: (id: string | null) => void }) {
  const opened = t.parts.find((p) => p.mail.id === open)?.mail;
  const past = t.end + 86_400_000 < Date.now();
  return (
    <section className={`mailx-trip b-trips${past ? " past" : ""}`} aria-label={`${t.name}, ${tripDates(t)}`}>
      <div className="mailx-trip-head">
        <span className="mailx-av bundle b-trips" aria-hidden="true"><Icon name="trips" /></span>
        <span><b>{t.name}</b><span className="muted"> · {tripDates(t)}{past ? " · Over" : ""}</span></span>
      </div>
      <ol className="mailx-trip-parts">
        {t.parts.map((p, i) => (
          <li key={i}>
            <button type="button" className={`mailx-trip-part${isUnread(p.mail) ? " unread" : ""}`} aria-expanded={open === p.mail.id} onClick={() => setOpen(open === p.mail.id ? null : p.mail.id)}>
              <span className="when">{cardTime(p.card.at!)}</span>
              <span className="what">{cardLine({ ...p.card, at: undefined })}</span>
            </button>
          </li>
        ))}
      </ol>
      {opened && <Card m={opened} close={() => setOpen(null)} />}
    </section>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const at12 = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); const d = new Date(); d.setHours(h || 0, m || 0, 0, 0); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };

/**
 * When this bundle's mail shows in the Inbox: as it arrives, once a day, once a week, or never (only here). Held mail
 * is always listed here; pinned mail always shows in the Inbox. Kept on the hub for every device.
 */
function DeliveryControl({ b, mails }: { b: Bundle; mails: MailThread[] }) {
  const { delivery, act, notifyOn } = useContext(Look);
  const d = delivery[b.id] ?? { mode: "now" };
  const notifies = notifyOn.bundles.includes(b.id);
  const save = (next: BundleDelivery) => void act((c) => c.mailBundleDelivery(b.id, next));
  const held = mails.filter((m) => m.state === "inbox" && !m.pinned && !inboxAt(m, delivery));
  const next = held.map((m) => deliveryAt(m.at, d)).filter((x): x is Date => !!x).sort((x, y) => x.getTime() - y.getTime())[0];
  return (
    <div className={`mailx-delivery ${bundleClass(b)}`}>
      <label>Show in Inbox
        <select value={d.mode} onChange={(e) => {
          const mode = e.target.value as BundleDelivery["mode"];
          save(mode === "daily" ? { mode, time: d.time ?? "07:00" } : mode === "weekly" ? { mode, time: d.time ?? "18:00", day: d.day ?? 0 } : { mode });
        }}>
          <option value="now">as it arrives</option>
          <option value="daily">once a day</option>
          <option value="weekly">once a week</option>
          <option value="never">never (only here)</option>
        </select>
      </label>
      <label title={d.mode === "never" ? "This bundle skips the Inbox, so it never notifies" : d.mode === "now" ? "A notification when new mail arrives in this bundle" : "A notification when this bundle's mail shows in your Inbox"}>
        <input type="checkbox" checked={notifies} disabled={d.mode === "never"} onChange={(e) => void act((c) => c.mailNotify({ bundle: b.id, on: e.target.checked }))} /> Notify me
      </label>
      {d.mode === "weekly" && (
        <label>on <select value={d.day ?? 0} onChange={(e) => save({ ...d, day: Number(e.target.value) })}>{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</select></label>
      )}
      {(d.mode === "daily" || d.mode === "weekly") && (
        <label>at <input type="time" value={d.time ?? "07:00"} onChange={(e) => e.target.value && save({ ...d, time: e.target.value })} /></label>
      )}
      <span className="muted">
        {d.mode === "never" ? "This bundle's mail stays out of your Inbox; it is all here."
          : held.length && next ? `${held.length} waiting: ${next.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`
          : d.mode === "daily" ? `New mail shows in your Inbox each day at ${at12(d.time ?? "07:00")}.`
          : d.mode === "weekly" ? `New mail shows in your Inbox each ${WEEKDAYS[d.day ?? 0]} at ${at12(d.time ?? "18:00")}.`
          : "Pinned mail always shows in your Inbox."}
      </span>
    </div>
  );
}

/** One rule per line, as typed: blank lines and spaces at the ends left out. */
const lines = (s: string) => s.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);

/**
 * A bundle of the owner's, made or changed: a name, one of eight colors, and rules: mail from these addresses, from
 * these domains (and domains under them), or whose subject has these words. Checked before the built-in bundles, so
 * yours wins; a person's mail can be in one.
 */
function BundleForm({ start, close, saved }: { start: CustomBundle | null; close: () => void; saved: (id: string | null) => Promise<void> }) {
  const [name, setName] = useState(start?.name ?? "");
  const [color, setColor] = useState(start?.color ?? 0);
  const [addresses, setAddresses] = useState((start?.addresses ?? []).join("\n"));
  const [domains, setDomains] = useState((start?.domains ?? []).join("\n"));
  const [words, setWords] = useState((start?.words ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const c = engine.client;
  const save = async () => {
    if (!c) return;
    setBusy(true); setErr("");
    try {
      const b = { name, color, addresses: lines(addresses), domains: lines(domains), words: lines(words) };
      const r = start ? await c.mailBundleUpdate({ ...b, id: start.id }) : await c.mailBundleAdd(b);
      await saved(r.id);
    } catch (e) { setErr(plainError(e)); setBusy(false); }
  };
  const remove = async () => {
    if (!c || !start || !window.confirm(`Delete the bundle "${start.name}"? Its mail goes back to the other bundles; nothing in your mailbox changes.`)) return;
    setBusy(true);
    try { await c.mailBundleDelete(start.id); await saved(null); } catch (e) { setErr(plainError(e)); setBusy(false); }
  };
  return (
    <form className="mailx-bundleform" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>{start ? `Edit ${start.name}` : "New bundle"}</h2>
      <label>Name <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="School" autoFocus /></label>
      <div className="mailx-swatches" role="radiogroup" aria-label="Color">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <button key={i} type="button" role="radio" aria-checked={color === i} aria-label={`Color ${i + 1}`} className={`mailx-swatch b-custom cc${i}${color === i ? " on" : ""}`} onClick={() => setColor(i)} />
        ))}
      </div>
      <p className="muted small">Mail goes in this bundle when it matches any line below. Your bundles are checked before the built-in ones, and a person's mail can be in one.</p>
      <label>From these addresses <textarea rows={3} value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder={"coach@league.example\nsam@example.com"} /></label>
      <label>From these domains (and any under them) <textarea rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="school.example" /></label>
      <label>Subject has these words <textarea rows={3} value={words} onChange={(e) => setWords(e.target.value)} placeholder={"field trip\npermission slip"} /></label>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button type="submit" disabled={busy || !name.trim()}>{start ? "Save" : "Make bundle"}</button>
        <button type="button" className="link" onClick={close}>Cancel</button>
        {start && <button type="button" className="link danger" onClick={() => void remove()}>Delete bundle</button>}
      </div>
    </form>
  );
}

function ModuleLink({ b }: { b: Bundle }) {
  if (!b.module || !b.screen) return null;
  return (
    <div className={`mailx-module ${bundleClass(b)}`}>
      <span>Sorted using your {b.moduleName} records.</span>
      <a href={`#${b.screen}`}>Open {b.moduleName} ›</a>
    </div>
  );
}

function BundleRow({ b, nav, mails, isOpen, toggle, open, setOpen }: { b: Bundle; nav: string; mails: MailThread[]; isOpen: boolean; toggle: () => void; open: string | null; setOpen: (id: string | null) => void }) {
  const { cursor } = useContext(Look);
  const unread = mails.filter(isUnread).length;
  // The Trips row says the next trip not over yet ("Trip to JFK, Dec 3 to 6"), else who the mail is from.
  const soon = b.id === "trips" ? tripsOf(mails)[0] : undefined;
  const next = soon && soon.end + 86_400_000 >= Date.now() ? soon : null;
  return (
    <div className={`mailx-bundle ${bundleClass(b)}${isOpen ? " open" : ""}${cursor === nav ? " cursor" : ""}`} data-nav={nav}>
      <button type="button" className={`mailx-row${unread ? " unread" : ""}`} aria-expanded={isOpen} onClick={toggle}>
        <span className="mailx-dotcol">{!!unread && <span className="mailx-dot" title="Unread mail inside" />}</span>
        <span className="mailx-av bundle"><Icon name={b.custom !== undefined ? "own" : b.id} /></span>
        <span className="mailx-what">
          <span className="who"><b className="bname">{b.name}</b><span className="chip">{unread ? `${unread} new` : mails.length}</span></span>
          <span className="line">{next ? `${next.name}, ${tripDates(next)}` : sendersLine(mails)}</span>
        </span>
        <span className="when">{whenLabel(mails[0].at)}</span>
      </button>
      {isOpen && (
        <>
          <ModuleLink b={b} />
          <div className="mailx-bundle-acts"><Sweep mails={mails} /></div>
          {mails.map((m) => <Row key={m.id} m={m} open={open === m.id} setOpen={setOpen} />)}
        </>
      )}
    </div>
  );
}

/**
 * Swiping a row on a touch screen: right for Done (Move to Inbox in Done), left for Snooze (null: none). Only touch, never
 * a mouse; the row keeps `touch-action: pan-y`, so the list still scrolls and a sideways move comes here. A swipe let go
 * short of swipeAction's distance slides back, and the tap that ends a swipe does not open the mail.
 */
function useSwipe(on: boolean, done: () => void, snooze: (() => void) | null) {
  const [dx, setDx] = useState(0);
  const at = useRef<{ x: number; y: number; id: number; lock: "h" | "v" | null; dx: number; w: number } | null>(null);
  const swiped = useRef(false);
  const handlers = on ? {
    onPointerDown: (e: RPointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch") return;
      at.current = { x: e.clientX, y: e.clientY, id: e.pointerId, lock: null, dx: 0, w: e.currentTarget.offsetWidth };
    },
    onPointerMove: (e: RPointerEvent<HTMLElement>) => {
      const s = at.current;
      if (!s || e.pointerId !== s.id) return;
      const x = e.clientX - s.x;
      if (!s.lock) { s.lock = swipeLock(x, e.clientY - s.y); if (s.lock === "h") e.currentTarget.setPointerCapture(e.pointerId); }
      if (s.lock !== "h") return;
      s.dx = x < 0 && !snooze ? 0 : x;
      setDx(s.dx);
    },
    onPointerUp: () => {
      const s = at.current;
      at.current = null;
      if (!s || s.lock !== "h") return;
      swiped.current = true;
      setDx(0);
      const a = swipeAction(s.dx, s.w);
      if (a === "done") done();
      else if (a === "snooze") snooze?.();
    },
    onPointerCancel: () => { at.current = null; setDx(0); },
    onClickCapture: (e: RMouseEvent) => { if (swiped.current) { swiped.current = false; e.preventDefault(); e.stopPropagation(); } },
  } : {};
  return { dx, handlers };
}

function Row({ m, open, setOpen }: { m: MailThread; open: boolean; setOpen: (id: string | null) => void }) {
  const { cursor, selected, pick, move, setSnoozeFor, openMail } = useContext(Look);
  const back = m.state === "done";
  const swipe = useSwipe(!open && selected.size === 0,
    () => void move(back ? m.ids.done : m.ids.open, back ? "inbox" : "done"),
    back ? null : () => { setSnoozeFor(m.id); openMail(m.id); });
  if (open) return <Card m={m} close={() => setOpen(null)} />;
  const picked = selected.has(m.id);
  const dx = swipe.dx;
  const armed = swipeAction(dx, 400) !== null;
  // The row opens the mail; its actions show when it is pointed at or tabbed to (on a phone, open the mail for them,
  // or swipe). Its circle turns into a checkbox when pointed at, or while anything is selected.
  return (
    <div className={`mailx-item${cursor === m.id ? " cursor" : ""}${picked ? " picked" : ""}${dx ? " swiping" : ""}`} data-nav={m.id} {...swipe.handlers}>
      {dx > 0 && <span className={`mailx-swipe done${armed ? " armed" : ""}`} aria-hidden="true"><Icon name={back ? "inbox" : "check"} />{back ? "Move to Inbox" : "Done"}</span>}
      {dx < 0 && <span className={`mailx-swipe snooze${armed ? " armed" : ""}`} aria-hidden="true">Snooze<Icon name="clock" /></span>}
      <button type="button" className="mailx-pick" role="checkbox" aria-checked={picked} aria-label={`Select ${m.subject || "this mail"}`} onClick={(e) => pick(m.id, e.shiftKey)}>
        <Icon name="check" />
      </button>
      <button type="button" className={`mailx-row${isUnread(m) ? " unread" : ""}`} style={dx ? { transform: `translateX(${dx}px)` } : undefined} onClick={() => setOpen(m.id)}>
        <span className="mailx-dotcol">{isUnread(m) && <span className="mailx-dot" title="Unread" />}</span>
        <Avatar m={m} />
        <span className="mailx-what">
          <span className="who"><b>{m.people}</b>{m.pinned && <span className="pinmark" title="Pinned"><Icon name="pin" /></span>}{!!m.attachments && <span className="clipmark" title={m.attachments === 1 ? "An attachment" : `${m.attachments} attachments`}><Icon name="clip" /></span>}</span>
          <span className="line"><span className="subj">{m.subject || "(no subject)"}</span>{m.preview && <> · {m.preview}</>}</span>
          {/* Its first card's facts, as text (the row is a button: Track is on the open mail). */}
          {m.cards?.[0] && <span className={`mailx-cardline b-${CARD_ICON[m.cards[0].kind]}`}><Icon name={CARD_ICON[m.cards[0].kind]} />{cardLine(m.cards[0])}</span>}
        </span>
        <span className="when">{m.state === "snoozed" && m.snooze_until ? `Until ${whenLabel(m.snooze_until)}` : whenLabel(m.at)}</span>
      </button>
      <span className="mailx-acts"><PinButton m={m} /><SnoozeButton m={m} /><DoneButton m={m} /></span>
    </div>
  );
}

/**
 * A sender's circle: the brand's logo when iCloud verified it; for other mail a system sent, the sender's initials on
 * its bundle's color (TC for Trade Coffee on Purchases green); for a person, or mail in no bundle, initials on gray.
 */
function Avatar({ m }: { m: MailSummary }) {
  const { logos, shown } = useContext(Look);
  const logo = m.logo_domain ? logoSrc(logos[m.logo_domain]) : null;
  if (logo) return <span className="mailx-av logo" aria-hidden="true"><img src={logo} alt="" /></span>;
  const b = m.automated ? bundleOf(m, shown) : null;
  if (b) return <span className={`mailx-av bundle ${bundleClass(b)}`} aria-hidden="true">{initials(m.from)}</span>;
  return <span className="mailx-av" aria-hidden="true">{initials(m.from)}</span>;
}

/** Pin or unpin: the pin filled while pinned. `labelled`: with its word beside it (an open mail's bar). */
function PinButton({ m, labelled = false }: { m: MailThread; labelled?: boolean }) {
  const { act } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const label = m.pinned ? "Unpin" : "Pin";
  return (
    <button type="button" className={`mailx-act${m.pinned ? " on" : ""}`} aria-pressed={m.pinned} title={label} aria-label={label} disabled={busy}
      onClick={async () => { setBusy(true); await act((c) => c.mailPin(m.id, !m.pinned)); setBusy(false); }}>
      <Icon name="pin" />{labelled && <span>{label}</span>}
    </button>
  );
}

/** Done (moves the thread's mail to Archive in iCloud), or for a done thread, Move to Inbox. */
function DoneButton({ m, labelled = false }: { m: MailThread; labelled?: boolean }) {
  const { move } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const back = m.state === "done";
  const label = back ? "Move to Inbox" : "Done";
  return (
    <button type="button" className="mailx-act" title={back ? "Move back to the Inbox in iCloud" : "Done: moves it to Archive in iCloud"} aria-label={label} disabled={busy}
      onClick={async () => { setBusy(true); await move(back ? m.ids.done : m.ids.open, back ? "inbox" : "done"); setBusy(false); }}>
      <Icon name={back ? "inbox" : "check"} />{labelled && <span>{label}</span>}
    </button>
  );
}

/**
 * Snooze: shows the snooze choices on the open mail (a row's button opens it with them). For a snoozed mail, Unsnooze
 * brings it back now; its choices change the time.
 */
function SnoozeButton({ m, labelled = false }: { m: MailThread; labelled?: boolean }) {
  const { snoozeFor, setSnoozeFor, openMail, unsnooze } = useContext(Look);
  if (m.state === "done") return null;
  const showing = snoozeFor === m.id;
  return (
    <>
      <button type="button" className={`mailx-act${showing ? " on" : ""}`} aria-expanded={showing} title={m.state === "snoozed" ? "Change when it comes back" : "Snooze: hide it until a time you pick"} aria-label="Snooze"
        onClick={() => { setSnoozeFor(showing ? null : m.id); if (!showing) openMail(m.id); }}>
        <Icon name="clock" />{labelled && <span>{m.state === "snoozed" ? "Change snooze" : "Snooze"}</span>}
      </button>
      {labelled && m.state === "snoozed" && (
        <button type="button" className="mailx-act" onClick={() => void unsnooze(m)}><Icon name="inbox" /><span>Unsnooze</span></button>
      )}
    </>
  );
}

/** The snooze choices (later today, tomorrow, the weekend, next week) and a date and time of your own. */
function SnoozePicker({ m }: { m: MailThread }) {
  const { snooze, snoozeTimes } = useContext(Look);
  const [editing, setEditing] = useState(false);
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (at: Date) => { setBusy(true); await snooze(m, at); setBusy(false); };
  const ownAt = own ? new Date(own) : null;
  const ownOk = !!ownAt && !Number.isNaN(ownAt.getTime()) && ownAt.getTime() > Date.now() + 60_000;
  return (
    <div className="mailx-snooze mailx-card-pad" role="group" aria-label="Snooze until">
      {snoozeChoices(new Date(), snoozeTimes).map((c) => (
        <button key={c.id} type="button" className="mailx-snooze-choice" disabled={busy} onClick={() => void go(c.at)}>
          <b>{c.label}</b><span>{c.at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
        </button>
      ))}
      <label className="mailx-snooze-own">
        <span>Pick a date and time</span>
        <input type="datetime-local" value={own} onChange={(e) => setOwn(e.target.value)} />
        <button type="button" disabled={busy || !ownOk} onClick={() => ownAt && void go(ownAt)}>Snooze</button>
      </label>
      <button type="button" className="link mailx-snooze-edit" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? "Close" : "Change these times"}</button>
      {editing && <SnoozeTimesForm done={() => setEditing(false)} />}
    </div>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What "Later today", "Tomorrow", "This weekend" and "Next week" mean, kept on the hub for every device. */
function SnoozeTimesForm({ done }: { done: () => void }) {
  const { snoozeTimes, act } = useContext(Look);
  const [t, setT] = useState<SnoozeTimes>(snoozeTimes);
  const [busy, setBusy] = useState(false);
  const day = (k: "weekend_day" | "week_day") => (
    <select value={t[k]} onChange={(e) => setT({ ...t, [k]: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
  );
  const time = (k: "tomorrow" | "weekend_time" | "week_time") => <input type="time" value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} />;
  return (
    <form className="mailx-snooze-times" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await act((c) => c.mailSnoozeTimes(t)); setBusy(false); done(); }}>
      <label>Later today <input type="number" min={1} max={12} value={t.later_hours} onChange={(e) => setT({ ...t, later_hours: Number(e.target.value) })} /> hours on</label>
      <label>Tomorrow at {time("tomorrow")}</label>
      <label>This weekend: {day("weekend_day")} at {time("weekend_time")}</label>
      <label>Next week: {day("week_day")} at {time("week_time")}</label>
      <div className="row"><button type="submit" disabled={busy}>Save</button><button type="button" className="link" onClick={() => setT(SNOOZE_DEFAULTS)}>Back to the usual times</button></div>
    </form>
  );
}

/** Snooze for several selected threads: the same choices, one task each. */
function MultiSnooze({ count, pick, close }: { count: number; pick: (until: Date) => void; close: () => void }) {
  const { snoozeTimes } = useContext(Look);
  const [own, setOwn] = useState("");
  const ownAt = own ? new Date(own) : null;
  const ok = !!ownAt && !Number.isNaN(ownAt.getTime()) && ownAt.getTime() > Date.now() + 60_000;
  return (
    <div className="mailx-snooze mailx-multisnooze" role="group" aria-label={`Snooze ${count} until`}>
      <b>Snooze {count} until</b>
      {snoozeChoices(new Date(), snoozeTimes).map((c) => (
        <button key={c.id} type="button" className="mailx-snooze-choice" onClick={() => pick(c.at)}>
          <b>{c.label}</b><span>{c.at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
        </button>
      ))}
      <label className="mailx-snooze-own"><span>Pick a date and time</span><input type="datetime-local" value={own} onChange={(e) => setOwn(e.target.value)} />
        <button type="button" disabled={!ok} onClick={() => ownAt && pick(ownAt)}>Snooze</button></label>
      <button type="button" className="link mailx-snooze-edit" onClick={close}>Cancel</button>
    </div>
  );
}

/** A thread's mail that Delete, Spam and Move to take: its received mail in the Inbox, snoozed or done (never the owner's replies). */
const threadIds = (m: MailThread) => [...m.ids.open, ...m.ids.done];

/** Delete, Spam (`spam`) and Move to one of the owner's folders, for mail in the Inbox, Snoozed or Done; Undo sends it `back`. */
function MoveButtons({ ids, back, spam = false }: { ids: string[]; back: MoveTarget | null; spam?: boolean }) {
  const { relocate, folders } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const go = async (to: MoveTarget, said: string) => { setBusy(true); await relocate(ids, to, said, back); setBusy(false); };
  const own = folders.filter((f) => f.role === "own");
  return (
    <>
      <button type="button" className="mailx-act" disabled={busy} title="Delete: moves it to Trash in iCloud" onClick={() => void go("trash", "Moved to Trash")}><Icon name="trash" /><span>Delete</span></button>
      {spam && <button type="button" className="mailx-act" disabled={busy} title="Spam: moves it to Spam (Junk) in iCloud" onClick={() => void go("junk", "Moved to Spam")}><Icon name="spam" /><span>Spam</span></button>}
      {!!own.length && <MoveMenu folders={own} disabled={busy} pick={(f) => void go(f.key, `Moved to ${folderLabel(f)}`)} />}
    </>
  );
}

/** Move to: one of the owner's folders. */
function MoveMenu({ folders, disabled, pick }: { folders: MailFolder[]; disabled: boolean; pick: (f: MailFolder) => void }) {
  return (
    <select className="mailx-movemenu" aria-label="Move to a folder" disabled={disabled} value="" onChange={(e) => { const f = folders.find((x) => x.key === e.target.value); if (f) pick(f); }}>
      <option value="">Move to…</option>
      {folders.map((f) => <option key={f.key} value={f.key}>{folderLabel(f)}</option>)}
    </select>
  );
}

/**
 * A folder mail's actions, by its folder: Spam has Not spam and Delete; Trash has Move to Inbox; the owner's folders have
 * Move to Inbox, Delete and Move to; Sent and Drafts have Delete (no Undo: nothing is moved into Sent or Drafts).
 */
function FolderActions({ m, f }: { m: FolderMail; f: MailFolder }) {
  const { relocate, folders } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const go = async (to: MoveTarget, said: string, back: MoveTarget | null) => { setBusy(true); await relocate([m.id], to, said, back); setBusy(false); };
  const here: MoveTarget = f.role === "own" ? f.key : f.role;
  const others = folders.filter((x) => x.role === "own" && x.key !== f.key);
  const toInbox = <button type="button" className="mailx-act" disabled={busy} onClick={() => void go("inbox", "Moved to Inbox", here)}><Icon name="inbox" /><span>{f.role === "junk" ? "Not spam" : "Move to Inbox"}</span></button>;
  const del = <button type="button" className="mailx-act" disabled={busy} title="Delete: moves it to Trash in iCloud" onClick={() => void go("trash", "Moved to Trash", f.role === "sent" || f.role === "drafts" ? null : here)}><Icon name="trash" /><span>Delete</span></button>;
  return (
    <>
      {(f.role === "junk" || f.role === "trash" || f.role === "own") && toInbox}
      {f.role !== "trash" && del}
      {f.role === "own" && !!others.length && <MoveMenu folders={others} disabled={busy} pick={(x) => void go(x.key, `Moved to ${folderLabel(x)}`, here)} />}
      {f.role === "trash" && <span className="muted small">Mail in Trash is erased only from Apple Mail.</span>}
    </>
  );
}

/** Sweep: every unpinned thread here marked done at once (pinned ones stay), with one Undo. */
function Sweep({ mails }: { mails: MailThread[] }) {
  const { move } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const ids = mails.filter((m) => !m.pinned && m.state !== "done").flatMap((m) => m.ids.open);
  if (!ids.length) return null;
  return (
    <button type="button" className="mailx-act mailx-sweep" title={`Mark ${ids.length} done (pinned mail stays)`} disabled={busy}
      onClick={async () => { setBusy(true); await move(ids, "done"); setBusy(false); }}>
      <Icon name="check" /><span>Sweep</span>
    </button>
  );
}

/**
 * An open thread: its messages oldest first, the newest and any unread open, the others folded to a line each. A single
 * mail opens as before. Opening reads the thread's unread mail: on the hub and in the mailbox (its read flag only).
 */
function Card({ m, close }: { m: MailThread; close: () => void }) {
  const { snoozeFor, act, selected, pick, showPerson } = useContext(Look);
  const picked = selected.has(m.id);
  // The unread messages that open by themselves: the newest few. Each open message is a frame of its own, and a
  // thread of any length opening all at once is more than a page should carry.
  const [openUnread] = useState(() => new Set(m.members.filter(isUnread).slice(-OPEN_UNREAD_MAX).map((x) => x.id)));
  useEffect(() => {
    if (m.ids.unread.length) void act(async (c) => { for (const part of batches(m.ids.unread)) await c.mailSeenMany(part, true); });
    // Only when it opens: Mark unread must not be undone by the card that is closing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id]);
  const single = m.members.length === 1;
  // Reply answers the thread's newest mail from someone else (never the owner's own reply).
  const answer = [...m.members].reverse().find((x) => !x.mine);
  // Which writing box is open: a reply, a reply to all, or a forward of the thread's newest mail from someone else.
  const [replying, setReplying] = useState<"one" | "all" | "forward" | null>(null);
  const [tools, setTools] = useState(false);
  const writeBtn = (k: "one" | "all" | "forward", icon: string, label: string, title: string) => (
    <button type="button" className={`mailx-act${replying === k ? " on" : ""}`} aria-expanded={replying === k} title={title} onClick={() => setReplying((x) => (x === k ? null : k))}><Icon name={icon} /><span>{label}</span></button>
  );
  return (
    <article className={`mailx-card${picked ? " picked" : ""}`} data-nav={m.id}>
      {/* As on a row: the circle turns into a checkbox when pointed at, or while anything is selected. */}
      <button type="button" className="mailx-pick" role="checkbox" aria-checked={picked} aria-label={`Select ${m.subject || "this mail"}`} onClick={(e) => pick(m.id, e.shiftKey)}>
        <Icon name="check" />
      </button>
      <button type="button" className="mailx-card-head" onClick={close} aria-expanded="true">
        <Avatar m={m} />
        <span className="mailx-what">
          <span className="subject">{m.subject || "(no subject)"}</span>
          {/* The real address, always: a display name can say anything. A thread shows each message's below. */}
          <span className="meta">{single ? <><b>{personLabel(m.from)}</b> &lt;{m.from.address}&gt; · {fmtDateTime(m.at)}</> : <>{m.people}</>}</span>
        </span>
      </button>
      <div className="mailx-card-acts mailx-card-pad"><DoneButton m={m} labelled /><SnoozeButton m={m} labelled /><PinButton m={m} labelled />
        <button type="button" className="mailx-act" title="Mark unread, here and in your mail app" onClick={() => { close(); void act((c) => c.mailSeen(m.id, false)); }}><Icon name="dot" /><span>Mark unread</span></button>
        <MoveButtons ids={threadIds(m)} back="inbox" spam />
        {answer && <button type="button" className={`mailx-act${tools ? " on" : ""}`} aria-expanded={tools} title="Unsubscribe from this sender's mail, or block them" onClick={() => setTools((x) => !x)}><Icon name="spam" /><span>Unsubscribe or block</span></button>}
        {answer && <button type="button" className="mailx-act" title={`All your mail with ${answer.from.address}`} onClick={() => showPerson(answer.from)}><Icon name="person" /><span>All with {personLabel(answer.from).split(/\s+/)[0]}</span></button>}
        {answer && writeBtn("one", "reply", "Reply", "Write a reply, saved to Drafts in iCloud")}
        {answer && writeBtn("all", "replyall", "Reply all", "Reply to the sender and everyone else on the mail, saved to Drafts in iCloud")}
        {answer && writeBtn("forward", "forward", "Forward", "Forward it to someone, saved to Drafts in iCloud")}
      </div>
      {tools && answer && <SenderTools m={answer} close={() => setTools(false)} />}
      {replying && answer && (replying === "forward"
        ? <Composer key="forward" forward={answer} close={() => setReplying(null)} />
        : <Composer key={replying} reply={answer} all={replying === "all"} close={() => setReplying(null)} />)}
      {m.state === "snoozed" && m.snooze_until && <div className="muted small mailx-card-pad">Snoozed until {fmtDateTime(m.snooze_until)}. It comes back to the top of your Inbox then; its task, called Snoozed mail, is in Tasks and Reminders.</div>}
      {snoozeFor === m.id && <SnoozePicker m={m} />}
      {single ? <Message m={m.members[0]} /> : m.members.map((x, i) => (
        <ThreadMessage key={x.id} m={x} startOpen={i === m.members.length - 1 || openUnread.has(x.id)} />
      ))}
    </article>
  );
}

/**
 * Writing mail, as a draft: a reply to an open mail (the hub sets its recipient, the sender's From; its subject and its
 * thread) or a new mail. Write, then Preview: the hub answers with the whole mail it would save, shown here as text,
 * and only Save to Drafts saves it, to iCloud's Drafts folder. The owner sends it from Apple Mail: nothing is sent here.
 */
/** A file's bytes as base64, for a draft. */
const fileB64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

function Composer({ reply, all = false, forward, draft, close }: { reply?: MailSummary; all?: boolean; forward?: MailSummary; draft?: { m: FolderMail; email: string }; close: () => void }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<MailDraft | null>(null);
  // Files the owner attaches (read in this browser, sent with the draft), and whether a forward carries the mail's own.
  const [files, setFiles] = useState<File[]>([]);
  const [withTheirs, setWithTheirs] = useState(!!forward?.attachments);
  const filesBytes = files.reduce((n, f) => n + f.size, 0);
  const addFiles = (list: FileList | null) => {
    const next = [...files, ...Array.from(list ?? [])].slice(0, DRAFT_FILES_MAX);
    if (next.reduce((n, f) => n + f.size, 0) > DRAFT_FILES_BYTES) { setErr("The files are more than 15 MB together. Send big files from Apple Mail (Mail Drop)."); return; }
    setErr("");
    setFiles(next);
  };
  // Editing a draft: its words come from the hub (the list has only their start), its recipients and subject from the list.
  useEffect(() => {
    if (!draft) return;
    setTo(draft.m.to.map((a) => a.address).join(", "));
    setSubject(draft.m.subject);
    let live = true;
    engine.client?.mailMessage(draft.m.id).then((x) => { if (live) setText(x.text); }).catch(() => undefined);
    return () => { live = false; };
  }, [draft?.m.id]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // A reply's greeting and sign-off: suggested by the hub (its local model, or the plain ones) when the reply opens,
  // each the owner's to edit or drop. Null: dropped. What the owner already typed in one is never overwritten.
  const [greeting, setGreeting] = useState<string | null>("");
  const [signoff, setSignoff] = useState<string | null>("");
  const [suggesting, setSuggesting] = useState(!!reply);
  // Smart replies: tapping one puts it in the text box, to edit like anything typed.
  const [smart, setSmart] = useState<string[]>([]);
  const touched = useRef({ greeting: false, signoff: false });
  useEffect(() => {
    if (!reply) return;
    let live = true;
    engine.client?.mailGreeting(reply.id).then((g) => {
      if (!live) return;
      if (!touched.current.greeting) setGreeting(g.greeting);
      if (!touched.current.signoff) setSignoff(g.signoff);
      setSmart(g.replies ?? []);
    }).catch(() => undefined).finally(() => { if (live) setSuggesting(false); });
    return () => { live = false; };
  }, [reply?.id]);
  const ask = async (asPreview: boolean) => {
    const c = engine.client;
    if (!c) return;
    setBusy(true);
    setErr("");
    try {
      const around = { ...(greeting?.trim() ? { greeting } : {}), ...(signoff?.trim() ? { signoff } : {}) };
      const sent = files.length ? await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, data: await fileB64(f) }))) : undefined;
      const r = await c.mailDraft({ ...(reply ? { reply_to: reply.id, ...(all ? { reply_all: true } : {}) } : forward ? { forward: forward.id, to, ...(withTheirs ? { forward_attachments: true } : {}) } : { to, subject, ...(draft ? { replaces: draft.m.id, from: draft.email } : {}) }), text, ...around, ...(sent ? { files: sent } : {}), ...(asPreview ? { preview: true } : {}) });
      if (asPreview) setPreview(r); else setSaved(true);
    } catch (e) { setErr(plainError(e)); }
    setBusy(false);
  };
  const head = reply ? <>{all ? "Reply all to" : "Reply to"} <b>{personLabel(reply.from)}</b> &lt;{reply.from.address}&gt;{all && " and the others on it"}</> : forward ? <>Forward <b>{forward.subject || "(no subject)"}</b></> : <b>New mail</b>;
  if (saved) {
    return (
      <div className="mailx-compose mailx-card-pad" role="status">
        <span>Saved to Drafts in iCloud. Open Drafts in Apple Mail to send it.</span>
        <button type="button" className="small" onClick={close}>Close</button>
      </div>
    );
  }
  if (preview) {
    return (
      <div className="mailx-compose mailx-card-pad" role="group" aria-label="The mail as it will be saved">
        <div className="muted small">This is the whole mail. Save it to Drafts, then send it from Apple Mail.</div>
        <dl className="mailx-compose-head">
          <dt>From</dt><dd>{preview.from.name ? `${preview.from.name} <${preview.from.address}>` : preview.from.address}</dd>
          <dt>To</dt><dd>{preview.to.join(", ")}</dd>
          {!!preview.cc?.length && <><dt>Cc</dt><dd>{preview.cc.join(", ")}</dd></>}
          {!!preview.files?.length && <><dt>Files</dt><dd>{preview.files.map((f) => `${f.name} (${fileSize(f.size)})`).join(", ")}</dd></>}
          {forward && withTheirs && <><dt>Also</dt><dd>The mail's own attachments, added from iCloud when it is saved</dd></>}
          <dt>Subject</dt><dd>{preview.subject || "(no subject)"}</dd>
        </dl>
        <div className="mailx-compose-text">{preview.text}</div>
        <div className="mailx-compose-acts">
          <button type="button" className="primary" disabled={busy} onClick={() => void ask(false)}>{busy ? "Saving" : "Save to Drafts"}</button>
          <button type="button" disabled={busy} onClick={() => setPreview(null)}>Edit</button>
          <button type="button" className="link" onClick={close}>Discard</button>
          {err && <span className="error small" role="alert">{err}</span>}
        </div>
      </div>
    );
  }
  return (
    <form className="mailx-compose mailx-card-pad" onSubmit={(e) => { e.preventDefault(); void ask(true); }}>
      <div>{head}</div>
      {/* The sender asked for replies to go elsewhere: say so, since the reply goes to the address it came from. */}
      {reply?.reply_to && <div className="warn small">This mail asks for replies to go to {reply.reply_to}. Your reply goes to the address it came from, {reply.from.address}.</div>}
      {!reply && (
        <>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To: alex@example.com" aria-label="To" autoComplete="off" spellCheck={false} />
          {!forward && <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" maxLength={200} />}
        </>
      )}
      {forward && <div className="muted small">The mail goes below your words.</div>}
      {forward && !!forward.attachments && <label className="mailx-check small"><input type="checkbox" checked={withTheirs} onChange={(e) => setWithTheirs(e.target.checked)} /> Include its attachments ({forward.attachments})</label>}
      {draft && <div className="muted small">Saving puts this version in Drafts and moves the old one to Trash.</div>}
      {reply && !!smart.length && (
        <div className="mailx-smart" role="group" aria-label="Suggested replies">
          {smart.map((r) => <button key={r} type="button" className="mailx-smart-one" onClick={() => setText((t) => (t.trim() ? `${t.trimEnd()}\n${r}` : r))}>{r}</button>)}
        </div>
      )}
      {reply && <AroundLine label="Greeting" value={greeting} rows={1} waiting={suggesting} set={(v) => { touched.current.greeting = true; setGreeting(v); }} />}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={reply ? "Write your reply: just what you want to say" : forward ? "Add a note (optional)" : "Write your mail"} aria-label="Your mail" maxLength={50000} autoFocus />
      {!!files.length && (
        <ul className="mailx-att-list">
          {files.map((f, i) => <li key={`${f.name}-${i}`}><Icon name="clip" /><span className="name">{f.name}</span><span className="muted small">{fileSize(f.size)}</span><button type="button" className="small" onClick={() => setFiles(files.filter((_, j) => j !== i))}>Remove</button></li>)}
          <li className="muted small">{fileSize(filesBytes)} of 15 MB</li>
        </ul>
      )}
      {reply && <AroundLine label="Sign-off" value={signoff} rows={2} waiting={suggesting} set={(v) => { touched.current.signoff = true; setSignoff(v); }} />}
      <div className="mailx-compose-acts">
        <button type="submit" className="primary" disabled={busy || (!forward && !text.trim()) || (!reply && !to.trim())}>{busy ? "Checking" : "Preview"}</button>
        <button type="button" className="link" onClick={close}>Discard</button>
        <label className="mailx-attach" title="Attach files (at most 10, 15 MB in all)"><Icon name="clip" /><span>Attach</span><input type="file" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} /></label>
        <span className="muted small">Saved to Drafts in iCloud, to send from Apple Mail.</span>
        {err && <span className="error small" role="alert">{err}</span>}
      </div>
    </form>
  );
}

/**
 * A reply's greeting or sign-off: a short field (the hub takes at most 2 lines of plain words), with Remove; once
 * removed, Add brings back an empty one. `waiting`: the suggestion is on its way.
 */
function AroundLine({ label, value, rows, waiting, set }: { label: string; value: string | null; rows: number; waiting: boolean; set: (v: string | null) => void }) {
  if (value === null) return <button type="button" className="link small mailx-around-add" onClick={() => set("")}>Add a {label.toLowerCase()}</button>;
  return (
    <div className="mailx-around">
      <textarea value={value} onChange={(e) => set(e.target.value)} rows={rows} maxLength={130} aria-label={label} placeholder={waiting ? "Suggesting…" : label} />
      <button type="button" className="link small" onClick={() => set(null)} aria-label={`Remove the ${label.toLowerCase()}`}>Remove</button>
    </div>
  );
}

/**
 * Unsubscribe and Block for a mail's sender. Unsubscribe reads the mail's own ways now and says what each does: one
 * click through Tor, or (a hub without Tor) only after the owner accepts that the sender sees the home's address; the
 * sender's own page, opened in the browser with its host shown; or a draft to their unsubscribe address. Block sends
 * the sender's (or their domain's) mail to Spam, now and from now on.
 */
function SenderTools({ m, close }: { m: MailSummary; close: () => void }) {
  const { act } = useContext(Look);
  const [ways, setWays] = useState<UnsubscribeOptions | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [direct, setDirect] = useState(false);
  useEffect(() => {
    let live = true;
    engine.client?.mailUnsubscribeOptions(m.id).then((w) => { if (live) setWays(w); }).catch((e) => { if (live) setErr(plainError(e)); });
    return () => { live = false; };
  }, [m.id]);
  const run = async (f: () => Promise<string>) => {
    setBusy(true); setErr(""); setMsg("");
    try { setMsg(await f()); } catch (e) { setErr(plainError(e)); }
    setBusy(false);
  };
  const domain = m.from.address.split("@")[1] ?? "";
  const linkHost = ways?.link ? httpsLink(ways.link)?.host : undefined;
  return (
    <div className="mailx-compose mailx-card-pad" role="group" aria-label="Unsubscribe or block">
      <b>Unsubscribe</b>
      {!ways && !err && <span className="muted small">Reading the mail's unsubscribe links</span>}
      {ways && !ways.one_click && !ways.link && !ways.mailto && <span className="muted small">This mail has no unsubscribe link. You can block the sender instead.</span>}
      {ways?.one_click && (
        <div className="mailx-compose-acts">
          {ways.tor || direct
            ? <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => { const r = await engine.client!.mailUnsubscribe(m.id, "one_click", !ways.tor); return r.via === "tor" ? "Unsubscribed, through Tor." : "Unsubscribed."; })}>Unsubscribe</button>
            : <button type="button" disabled={busy} onClick={() => setDirect(true)}>Unsubscribe…</button>}
          <span className="muted small">{ways.tor ? `Your hub tells ${ways.one_click.host} through Tor, so it does not see your home's internet address.` : direct ? `Your hub will contact ${ways.one_click.host}, which then sees your home's internet address. Press Unsubscribe to go ahead.` : `One click: your hub contacts ${ways.one_click.host}.`}</span>
        </div>
      )}
      {ways?.link && linkHost && (
        <div className="mailx-compose-acts">
          <button type="button" onClick={() => void openExternal(ways.link!)}>Open their unsubscribe page</button>
          <span className="muted small">Opens {linkHost} in your browser.</span>
        </div>
      )}
      {ways?.mailto && (
        <div className="mailx-compose-acts">
          <button type="button" disabled={busy} onClick={() => void run(async () => { await engine.client!.mailUnsubscribe(m.id, "mailto"); return `A mail to ${ways.mailto!.to} is in Drafts: send it from Apple Mail.`; })}>Write the unsubscribe mail</button>
          <span className="muted small">To {ways.mailto.to}, saved in Drafts for you to send.</span>
        </div>
      )}
      <b>Block</b>
      <div className="mailx-compose-acts">
        <button type="button" disabled={busy} onClick={() => void run(async () => { const r = await engine.client!.mailBlock(m.from.address); await act(async () => undefined); return `Blocked ${m.from.address}: ${r.moved} moved to Spam, and their new mail goes there too.`; })}>Block {m.from.address}</button>
        {domain && <button type="button" disabled={busy} onClick={() => void run(async () => { const r = await engine.client!.mailBlock(`@${domain}`); await act(async () => undefined); return `Blocked everyone at ${domain}: ${r.moved} moved to Spam.`; })}>Block everyone at {domain}</button>}
      </div>
      {msg && <div className="small" role="status">{msg}</div>}
      {err && <div className="error small" role="alert">{err}</div>}
      <div><button type="button" className="link small" onClick={close}>Close</button></div>
    </div>
  );
}

/** One message of a thread: a line (who, when, first words) that opens to the whole message. */
function ThreadMessage({ m, startOpen }: { m: MailSummary; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <section className={`mailx-msg${open ? " open" : ""}${m.mine ? " mine" : ""}`}>
      <button type="button" className="mailx-msg-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="who"><b>{m.mine ? "You" : personLabel(m.from)}</b> &lt;{m.from.address}&gt;</span>
        <span className="when">{fmtDateTime(m.at)}</span>
        {!open && <span className="line">{m.preview}</span>}
      </button>
      {open && <Message m={m} />}
    </section>
  );
}

/**
 * A mail's cards above its body: each one's facts as text, and Track (a package) or Open when it has an https link.
 * The sender wrote all of it: nothing here is HTML, and the link opens outside the app, like any link in a mail.
 */
function MailFacts({ cards }: { cards: MailCard[] }) {
  return (
    <div className="mailx-facts mailx-card-pad">
      {cards.map((c, i) => {
        const href = cardLink(c);
        return (
          <div key={i} className={`mailx-fact b-${CARD_ICON[c.kind]}`}>
            <span className="mailx-av bundle" aria-hidden="true"><Icon name={CARD_ICON[c.kind]} /></span>
            <span className="what">{cardLine(c)}</span>
            {href && <button type="button" className="small" title={new URL(href).hostname} onClick={() => void openExternal(href)}>{c.kind === "package" ? "Track" : "Open"}</button>}
          </div>
        );
      })}
      {cards.some((c) => c.source === "text") && <span className="muted small">Read from the mail's text: check it against the mail.</span>}
    </div>
  );
}

/**
 * An open mail's attachments: read from the mailbox by the hub when the mail opens (the list kept with the mail says
 * whether there are any). Pictures show as previews (real pictures only, checked by the hub and here); each file has
 * Download, which saves it (never opens it here), after a warning for a kind of file that can run programs.
 */
function Attachments({ m }: { m: MailSummary }) {
  const [list, setList] = useState<MailAttachment[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    engine.client?.mailAttachments(m.id).then((r) => { if (live) setList(r.attachments); }).catch((e) => { if (live) setErr(plainError(e)); });
    return () => { live = false; };
  }, [m.id]);
  const save = async (a: MailAttachment) => {
    const c = engine.client;
    if (!c) return;
    if (riskyFile(a.name) && !window.confirm(`${a.name} is a kind of file that can run programs on your computer. Download it only if you expected it from ${m.from.address}.`)) return;
    setBusy(a.part);
    setErr("");
    try { saveBlob(await c.mailAttachment(m.id, a.part), a.name); } catch (e) { setErr(plainError(e)); }
    setBusy(null);
  };
  if (!list && !err) return m.attachments ? <div className="muted small mailx-card-pad">Loading {m.attachments === 1 ? "the attachment" : `${m.attachments} attachments`}</div> : null;
  if (list && !list.length) return null;
  return (
    <div className="mailx-atts mailx-card-pad">
      {list && list.some((a) => previewSrc(a.preview)) && (
        <div className="mailx-att-pics">
          {list.map((a) => { const src = previewSrc(a.preview); return src ? <button key={a.part} type="button" className="mailx-att-pic" title={`Download ${a.name}`} onClick={() => void save(a)}><img src={src} alt={a.name} /></button> : null; })}
        </div>
      )}
      {list && (
        <ul className="mailx-att-list">
          {list.map((a) => (
            <li key={a.part}>
              <Icon name="clip" />
              <span className="name">{a.name}</span>
              <span className="muted small">{fileSize(a.size)}</span>
              {riskyFile(a.name) && <span className="warn small">Can run programs</span>}
              <button type="button" className="small" disabled={busy === a.part} onClick={() => void save(a)}>{busy === a.part ? "Downloading" : "Download"}</button>
            </li>
          ))}
        </ul>
      )}
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

/** One message's body: the mail as sent (the hub's cleaned page), or its text; fetched from the hub when it shows. */
function Message({ m }: { m: MailSummary }) {
  const [full, setFull] = useState<MailMessage | null>(null);
  const [err, setErr] = useState("");
  const [asText, setAsText] = useState(false);
  // The quoted history under a reply: folded until "•••" is pressed (its page marks it, or its text's quote line).
  const [showQuote, setShowQuote] = useState(false);
  const [pageQuote, setPageQuote] = useState(false);
  const asPage = !!full?.html && !asText;
  const hasQuote = asPage ? pageQuote : full?.quote_at !== undefined;
  const text = full && !asPage && full.quote_at !== undefined && !showQuote ? full.text.slice(0, full.quote_at).trimEnd() : full?.text ?? "";
  useEffect(() => {
    let live = true;
    engine.client?.mailMessage(m.id).then((x) => { if (live) setFull(x); }).catch((e) => { if (live) setErr(plainError(e)); });
    return () => { live = false; };
  }, [m.id]);
  // Show pictures (a hub without Tor): the hub fetches this mail's pictures from its sender now, and the mail comes
  // back with them written in.
  const [pictures, setPictures] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });
  const showPictures = async () => {
    const c = engine.client;
    if (!c) return;
    setPictures({ busy: true, error: "" });
    try {
      setFull(await c.mailShowPictures(m.id));
      setPictures({ busy: false, error: "" });
    } catch (e) { setPictures({ busy: false, error: plainError(e) }); }
  };
  const askPictures = asPage && !!full?.pictures_ask;
  return (
    <>
      {nameHidesAddress(m.from) && <div className="warn small mailx-card-pad">The sender's name shows a different address than the one it came from.</div>}
      {!!m.cards?.length && <MailFacts cards={m.cards} />}
      {m.attachments !== undefined && <Attachments m={m} />}
      {askPictures && (
        <div className="mailx-pictures mailx-card-pad small">
          <button type="button" disabled={pictures.busy} onClick={() => void showPictures()}>{pictures.busy ? "Fetching pictures" : "Show pictures"}</button>
          <span className="muted">This mail's pictures are not loaded. Your hub would fetch them from the sender, who then sees your home's internet address. A hub with Tor loads pictures on its own, without showing it.</span>
          {pictures.error && <span className="error" role="alert">{pictures.error}</span>}
        </div>
      )}
      {err ? <div className="error mailx-card-pad">{err}</div>
        : !full ? <div className="muted small mailx-card-pad">Loading</div>
        : asPage ? <div className="mailx-page"><MailFrame doc={full.html!} title={m.subject || "Mail"} showQuote={showQuote} onQuote={setPageQuote} /></div>
        : <div className="mailx-text mailx-card-pad"><Linked text={text} /></div>}
      {full && hasQuote && (
        <div className="mailx-card-pad">
          <button type="button" className="mailx-fold" aria-expanded={showQuote} title={showQuote ? "Hide the quoted text" : "Show the quoted text"} onClick={() => setShowQuote(!showQuote)}>•••</button>
        </div>
      )}
      {full && (
        <div className="mailx-card-foot mailx-card-pad muted small">
          {full.html ? (
            <>
              {asText ? "Shown as text." : full.pictures_pending ? "The hub is still fetching this mail's pictures." : full.pictures_ask ? "Shown as sent, without its pictures." : "Shown as sent. Pictures were fetched by the hub, not this device."}
              {" "}<button type="button" className="link" onClick={() => setAsText(!asText)}>{asText ? "Show as sent" : "Show as text"}</button>
            </>
          ) : "Shown as text: this mail has no other version."}
        </div>
      )}
    </>
  );
}

/** The tallest a mail's frame gets, in px (a long newsletter is 10,000 to 15,000). */
const FRAME_MAX = 30_000;

/**
 * The mail as sent, in a frame sandboxed without the permission to run scripts: nothing in it can run, whatever got past the hub's
 * cleaning, and its own policy (mail-html.ts on the hub) loads nothing. `allow-same-origin` only lets this screen's
 * code reach in to size the frame to the mail and take its link clicks: a link opens in the browser (http, https or
 * mailto only), never inside the frame, and shows its real address when pointed at.
 */
function MailFrame({ doc, title, showQuote, onQuote }: { doc: string; title: string; showQuote: boolean; onQuote: (has: boolean) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const unfold = useRef(showQuote);
  unfold.current = showQuote;
  /** The page has quoted history and something besides it. */
  const foldable = useRef(false);
  // The quoted history: the page folds it (its body's `aeneas-fold`); this screen's code unfolds it on "•••".
  useEffect(() => {
    const d = ref.current?.contentDocument;
    if (!d?.body) return;
    d.body.classList.toggle("aeneas-fold", foldable.current && !showQuote);
    // Measured as the frame's own fit does: at no height first, at most FRAME_MAX.
    const frame = ref.current!;
    frame.style.height = "0px";
    frame.style.height = `${Math.min(Math.max(d.documentElement.scrollHeight, 60), FRAME_MAX)}px`;
  }, [showQuote]);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a) return;
      e.preventDefault();
      const href = frameLink(a.getAttribute("href"));
      if (href) void openExternal(href);
    };
    const ready = () => {
      const d = frame.contentDocument;
      if (!d) return;
      // The mail's own height: measured with the frame at no height, then given to the frame. Measured in a frame
      // of its last height, a mail sized by the frame itself (height: 100% all the way up, or 110vh) grew with every
      // measurement: an ordinary newsletter by 24 px a frame without end, a crafted one to millions of px in seconds
      // (2026-11-20). At most FRAME_MAX tall; a longer mail scrolls inside its frame.
      const fit = () => {
        frame.style.height = "0px";
        frame.style.height = `${Math.min(Math.max(d.documentElement.scrollHeight, 60), FRAME_MAX)}px`;
      };
      for (const a of d.querySelectorAll("a[href]")) a.setAttribute("title", a.getAttribute("href") ?? "");
      // Folded only when something is left to read: a forward (or any mail that is all quote) folded was a blank page.
      d.body?.classList.add("aeneas-fold");
      foldable.current = !!d.querySelector(QUOTE_SELECTOR) && !!d.body && (d.body.innerText.trim().length > 0 || !!d.body.querySelector("img"));
      onQuote(foldable.current);
      d.body?.classList.toggle("aeneas-fold", foldable.current && !unfold.current);
      d.addEventListener("click", onClick);
      observer = new ResizeObserver(fit);
      observer.observe(d.documentElement);
      fit();
    };
    frame.addEventListener("load", ready);
    return () => { frame.removeEventListener("load", ready); observer?.disconnect(); frame.contentDocument?.removeEventListener("click", onClick); };
  }, [doc]);
  return <iframe ref={ref} className="mailx-frame" title={title} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={doc} />;
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="mailx-empty"><Icon name="sun" /><b>{title}</b><span>{text}</span></div>;
}

/**
 * Text with the https addresses written in it as links (the address itself is the link's text), opened in the browser.
 * An address in another alphabet's letters has its real host beside it.
 */
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          <Parts parts={textParts(line)} />
        </Fragment>
      ))}
    </>
  );
}

/** A line's pieces from textParts (which checks every link): text, and links opened in the browser. */
function Parts({ parts }: { parts: TextPart[] }) {
  return (
    <>
      {parts.map((p, j) => p.href ? (
        <Fragment key={j}>
          <a href={p.href} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); void openExternal(p.href!); }}>{p.text}</a>
          {p.host && <span className="muted small"> ({p.host})</span>}
          {p.warnHost && <span className="warn small" title="This address uses letters from another alphabet that look like these."> ({p.warnHost})</span>}
        </Fragment>
      ) : <Fragment key={j}>{p.text}</Fragment>)}
    </>
  );
}

/** The screen's own icons, drawn here (no image or font is loaded for them). */
const ICONS: Record<string, string> = {
  menu: "M4 7h16M4 12h16M4 17h16",
  inbox: "M4 13l2.5-7h11L20 13v5H4zM4 13h4.5l1 2h5l1-2H20",
  clock: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 8v4l3 2",
  check: "m5 12.5 4.5 4.5L19 7.5",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4",
  plus: "M12 5v14M5 12h14",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  reply: "M9 15l-5-5 5-5M4 10h10a6 6 0 0 1 6 6v3",
  send: "M4 12l16-8-6 16-3-7zM11 13l9-9",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM16 16l4 4",
  spam: "M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6zM12 8v5M12 16v.5",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  folder: "M3 6h6l2 2h10v11H3z",
  replyall: "M7 15l-5-5 5-5M12 15l-5-5 5-5M7 10h7a6 6 0 0 1 6 6v3",
  forward: "M15 15l5-5-5-5M20 10H10a6 6 0 0 0-6 6v3",
  person: "M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM4 20c1.5-4 4.5-6 8-6s6.5 2 8 6",
  clip: "M8 12.5l6.5-6.5a3 3 0 0 1 4.2 4.2L10 19a5 5 0 0 1-7-7l8-8",
  own: "M7 4h10v16l-5-4-5 4z",
  dot: "M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z",
  pin: "M9 4h6l-1 6 3 3H7l3-3zM12 13v7",
  sun: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  purchases: "M4 5h2l2 10h10l2-7H7M9 17.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6zM17 17.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z",
  trips: "M10 18 8 21M3 13l7 1 6-8c1-1.3 3-1 3 .5L17 14l3 5-2 1-4-4-4 1z",
  social: "M9 6a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM17 7.7a2.3 2.3 0 1 0 0 4.6a2.3 2.3 0 1 0 0-4.6zM3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M15 15c2.4-.4 4.6.8 5.5 3.5",
  promos: "M4 4h7l9 9-7 7-9-9zM8.5 7.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z",
  bills: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  pet: "M7 8.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM11 4.7a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM15.5 5.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM18 9.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM8.5 18c0-3 1.8-5.5 4-5.5s4 2.5 4 5.5c0 1.5-1.3 2-2.5 1.6l-1.5-.5-1.5.5C9.8 20 8.5 19.5 8.5 18z",
  jobs: "M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zM9 7V5h6v2M3 12h18",
  other: "M4 6h16M4 12h16M4 18h10",
};
function Icon({ name }: { name: string }) {
  return <svg className="mailx-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name] ?? ICONS.other} /></svg>;
}
