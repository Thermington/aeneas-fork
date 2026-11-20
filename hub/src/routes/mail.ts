import { Hono } from "hono";
import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { bundleDelivery, listMail, mailboxStates, mailLogos, mailMessage, mailNotify, markDone, MOVE_MAX, refreshMail, saveBundleDelivery, saveMailNotify, saveSnoozeTimes, setPinned, setSeen, showPictures, SNOOZE_MAX_DAYS, snoozeMail, snoozeTimes, undoDone, unsnoozeMail, wakeSnoozed, SEEN_MAX, setSeenMany } from "../mail-inbox.js";
import { readJsonObject } from "../http.js";
import { addCustomBundle, bundleContext, customBundles, deleteCustomBundle, updateCustomBundle } from "../mail-bundles.js";

/**
 * The Mail screen (module `mail_inbox`, CONTRACT.md Mail): the iCloud Inbox, sorted into bundles.
 * The whole `/mail` prefix is closed to the assistant's tools (ai/api-guard.ts): mail is the owner's to read.
 */
export function mailRoutes() {
  const r = new Hono<{ Variables: { hub: Hub } }>();

  r.get("/mail", (c) => {
    const hub = c.get("hub");
    wakeSnoozed(hub);
    return c.json({ messages: listMail(hub.mailDb, bundleContext(hub)), logos: mailLogos(hub.mailDb), mailboxes: mailboxStates(hub), snooze_times: snoozeTimes(hub.mailDb), bundle_delivery: bundleDelivery(hub.mailDb), custom_bundles: customBundles(hub.mailDb), mail_notify: mailNotify(hub.mailDb) });
  });

  // The owner's snooze times (what "Tomorrow" and the rest mean).
  // The owner's own bundles: a name, a color and rules, checked before the built-in ones.
  r.post("/mail/settings/custom-bundles", async (c) => c.json(addCustomBundle(c.get("hub").mailDb, await readJsonObject(c))));
  r.put("/mail/settings/custom-bundles/:id", async (c) => c.json(updateCustomBundle(c.get("hub").mailDb, c.req.param("id"), await readJsonObject(c))));
  r.delete("/mail/settings/custom-bundles/:id", (c) => {
    const db = c.get("hub").mailDb;
    const id = c.req.param("id");
    // Its "Show in Inbox" setting goes with it (cleared first: that needs the bundle to exist).
    if (bundleDelivery(db)[id] && customBundles(db).some((b) => b.id === id)) saveBundleDelivery(db, id, { mode: "now" });
    // And its alerts switch: a deleted bundle's id is not left in the notify settings.
    const n = mailNotify(db);
    if (n.bundles.includes(id)) saveMailNotify(db, { bundles: n.bundles.filter((b) => b !== id) });
    deleteCustomBundle(db, id);
    return c.json({ ok: true });
  });

  // New-mail notifications: mail from people, each bundle's switch, and what a notification says.
  r.put("/mail/settings/notify", async (c) => c.json(saveMailNotify(c.get("hub").mailDb, await readJsonObject(c))));

  // When a bundle's mail shows in the Inbox (as it arrives, once a day, once a week, never).
  r.put("/mail/settings/bundles/:id", async (c) => c.json(saveBundleDelivery(c.get("hub").mailDb, c.req.param("id"), await readJsonObject(c))));
  r.put("/mail/settings/snooze", async (c) => c.json(saveSnoozeTimes(c.get("hub").mailDb, await readJsonObject(c))));

  r.get("/mail/messages/:id", (c) => {
    const hub = c.get("hub");
    const m = mailMessage(hub.mailDb, c.req.param("id"), !!hub.cfg.torSocks);
    if (!m) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json(m);
  });

  // Show pictures, on a hub without Tor: this one mail's web pictures, fetched straight from the hub because the person
  // asked (its sender then sees the home's internet address). A hub with Tor fetches them itself and refuses this.
  r.post("/mail/messages/:id/pictures", async (c) => {
    const m = await showPictures(c.get("hub"), c.req.param("id"));
    if (!m) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json(m);
  });

  // Several at once (a thread's unread mails, a selection): one sign-in to the mailbox for all of them.
  r.post("/mail/seen", async (c) => {
    const body = await readJsonObject(c);
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (typeof body.seen !== "boolean") throw new StoreError(422, "seen is true or false");
    if (!ids.length || ids.length > SEEN_MAX || !Array.isArray(body.ids) || ids.length !== body.ids.length) throw new StoreError(422, `ids is a list of 1 to ${SEEN_MAX} message ids`);
    const r2 = await setSeenMany(c.get("hub"), ids, body.seen);
    return c.json({ ok: r2.ok, seen: body.seen, synced: r2.synced });
  });
  // Read or unread: on the hub, and in the mailbox (only its \Seen flag, fenced in the source).
  r.post("/mail/messages/:id/seen", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.seen !== "boolean") throw new StoreError(422, "seen is true or false");
    const r2 = await setSeen(c.get("hub"), c.req.param("id"), body.seen);
    if (!r2.ok) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json({ ok: true, seen: body.seen, synced: r2.synced });
  });

  // Pin: on the hub only; nothing changes in iCloud.
  r.post("/mail/messages/:id/pin", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.pinned !== "boolean") throw new StoreError(422, "pinned is true or false");
    if (!setPinned(c.get("hub").mailDb, c.req.param("id"), body.pinned)) throw new StoreError(404, "that message is not kept (it left the Inbox)");
    return c.json({ ok: true, pinned: body.pinned });
  });

  // Done (a Sweep is many at once) and Undo: the only routes that change the mailbox, a MOVE between Inbox and Archive.
  const ids = async (c: Parameters<typeof readJsonObject>[0]) => {
    const body = await readJsonObject(c);
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MOVE_MAX || !body.ids.every((x) => typeof x === "string" && x.length <= 64)) {
      throw new StoreError(422, `ids is a list of 1 to ${MOVE_MAX} message ids`);
    }
    return body.ids as string[];
  };
  r.post("/mail/done", async (c) => c.json(await markDone(c.get("hub"), await ids(c))));
  r.post("/mail/undo", async (c) => c.json(await undoDone(c.get("hub"), await ids(c))));

  // Snooze: on the hub only (the mail stays in iCloud's Inbox); a task called "Snoozed mail" reminds at `until`.
  r.post("/mail/messages/:id/snooze", async (c) => {
    const body = await readJsonObject(c);
    const until = typeof body.until === "string" ? new Date(body.until) : new Date(NaN);
    const now = Date.now();
    if (Number.isNaN(until.getTime()) || until.getTime() < now + 30_000 || until.getTime() > now + SNOOZE_MAX_DAYS * 86_400_000) {
      throw new StoreError(422, `until is a time from now to ${SNOOZE_MAX_DAYS} days ahead`);
    }
    if (!snoozeMail(c.get("hub"), c.req.param("id"), until)) throw new StoreError(404, "that message is not in the Inbox");
    return c.json({ ok: true, until: until.toISOString() });
  });
  r.post("/mail/messages/:id/unsnooze", (c) => {
    if (!unsnoozeMail(c.get("hub"), c.req.param("id"))) throw new StoreError(404, "that message is not snoozed");
    return c.json({ ok: true });
  });

  r.post("/mail/refresh", async (c) => c.json(await refreshMail(c.get("hub"), { owner: true })));

  return r;
}
