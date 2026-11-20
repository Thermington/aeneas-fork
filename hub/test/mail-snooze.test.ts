import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, fake, linked, type Msg } from "./fake-icloud-mail.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { refreshMail, wakeSnoozed, type MailSummary } from "../src/mail-inbox.js";

// Snooze: on the hub only (the mail stays in iCloud's Inbox), with a task that holds none of the mail's words. Made-up mail.

const inbox = (): Msg[] => [
  { uid: 1, folder: "INBOX", at: ago(5), subject: "Gutters this weekend", from: { name: "Alex", address: "alex@example.com" }, messageId: "a1@x", plain: "Saturday?" },
  { uid: 2, folder: "INBOX", at: ago(1), subject: "Newer one", from: { name: "Sam", address: "sam@example.com" }, messageId: "s1@x", plain: "Hi." },
];
const list = async (t: TestHub) => ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages;
const gutters = async (t: TestHub) => (await list(t)).find((m) => m.subject === "Gutters this weekend")!;
const tasks = (t: TestHub) => t.hub.store.list({ kind: "task", limit: 1000 }).filter((x) => x.fields.mail);
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const snooze = (t: TestHub, id: string, until: string) => t.api(`/mail/messages/${id}/snooze`, { method: "POST", json: { until } });

async function setUp() {
  const t = makeHub();
  linked(t);
  const msgs = inbox();
  const seen = fake(msgs);
  await t.api("/mail/refresh", { method: "POST" });
  return { t, msgs, seen };
}

test("mail snooze: the mail leaves the Inbox for Snoozed, a task reminds at the time with none of the mail's words in it, iCloud is not touched", async () => {
  const { t, msgs, seen } = await setUp();
  try {
    const m = await gutters(t);
    const calls = seen.calls.length;
    const until = inHours(20);
    assert.equal((await snooze(t, m.id, until)).status, 200);
    const s = await gutters(t);
    assert.deepEqual([s.state, s.snooze_until], ["snoozed", until]);
    const [task] = tasks(t);
    assert.deepEqual([task.fields.title, task.fields.remind_at, task.fields.mail, task.fields.status], ["Snoozed mail", until, m.id, "scheduled"]);
    // Tasks are open to the assistant and synced; mail is neither. Nothing the sender wrote is in the task.
    const written = JSON.stringify(task);
    for (const words of ["Gutters", "weekend", "Saturday", "Alex", "alex@example.com"]) assert.ok(!written.includes(words), `the task holds "${words}"`);
    assert.equal(seen.calls.length, calls, "nothing sent to iCloud");
    assert.equal(msgs[0].folder, "INBOX");

    // Snoozed again: the same task, a new time.
    const later = inHours(40);
    await snooze(t, m.id, later);
    assert.equal(tasks(t).length, 1);
    assert.equal(tasks(t)[0].fields.remind_at, later);
  } finally { done(t); }
});

test("mail snooze: it comes back at its time, at the top of the Inbox, and its task stays as the reminder", async () => {
  const { t } = await setUp();
  try {
    const m = await gutters(t);
    await snooze(t, m.id, inHours(2));
    assert.equal((await list(t))[0].subject, "Newer one");
    assert.equal(wakeSnoozed(t.hub, new Date(Date.now() + 3 * 3600_000)), 1);
    const back = await gutters(t);
    assert.equal(back.state, "inbox");
    assert.ok(back.back_at);
    assert.equal((await list(t))[0].subject, "Gutters this weekend", "listed by when it came back, above newer mail");
    assert.equal(tasks(t)[0].deleted_at, null);
    // Done with the mail is done with its task.
    await t.api("/mail/done", { method: "POST", json: { ids: [m.id] } });
    assert.equal(tasks(t)[0].fields.status, "done");
  } finally { done(t); }
});

test("mail snooze: marking its task done or deleting it brings the mail back at once; Unsnooze deletes the task", async () => {
  const { t } = await setUp();
  try {
    const m = await gutters(t);
    await snooze(t, m.id, inHours(20));
    t.hub.store.patch(tasks(t)[0].id, { status: "done" });
    assert.equal((await gutters(t)).state, "inbox", "task done");

    await snooze(t, m.id, inHours(20));
    const second = tasks(t).find((x) => x.fields.status !== "done")!;
    t.hub.store.patch(second.id, { deleted_at: new Date().toISOString() });
    assert.equal((await gutters(t)).state, "inbox", "task deleted");

    await snooze(t, m.id, inHours(20));
    const third = tasks(t).find((x) => !x.deleted_at && x.fields.status !== "done")!;
    assert.equal((await t.api(`/mail/messages/${m.id}/unsnooze`, { method: "POST", json: {} })).status, 200);
    assert.equal((await gutters(t)).state, "inbox");
    assert.ok(t.hub.store.get(third.id)!.deleted_at, "Unsnooze deletes the task it no longer needs");
  } finally { done(t); }
});

test("mail snooze: the owner's own snooze times are kept on the hub, checked, and sent with the list", async () => {
  const { t } = await setUp();
  try {
    const first = await (await t.api("/mail")).json() as { snooze_times: Record<string, unknown> };
    assert.deepEqual(first.snooze_times, { later_hours: 3, tomorrow: "08:00", weekend_day: 6, weekend_time: "09:00", week_day: 1, week_time: "08:00" });
    const r = await t.api("/mail/settings/snooze", { method: "PUT", json: { later_hours: 2, tomorrow: "07:30", weekend_day: 0 } });
    assert.deepEqual(await r.json(), { later_hours: 2, tomorrow: "07:30", weekend_day: 0, weekend_time: "09:00", week_day: 1, week_time: "08:00" });
    assert.equal(((await (await t.api("/mail")).json()) as { snooze_times: { tomorrow: string } }).snooze_times.tomorrow, "07:30");
    for (const bad of [{ later_hours: 0 }, { later_hours: 2.5 }, { tomorrow: "7:30" }, { tomorrow: "25:00" }, { week_day: 7 }, { weekend_time: "noon" }]) {
      assert.equal((await t.api("/mail/settings/snooze", { method: "PUT", json: bad })).status, 422, JSON.stringify(bad));
    }
    assert.ok(refuseToolCall("PUT", "/mail/settings/snooze"));
  } finally { done(t); }
});

test("mail snooze: times from now to a year ahead only; only kept Inbox mail; the assistant cannot snooze", async () => {
  const { t } = await setUp();
  try {
    const m = await gutters(t);
    for (const until of ["", "soon", new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 400 * 86400_000).toISOString()]) {
      assert.equal((await snooze(t, m.id, until)).status, 422, until);
    }
    assert.equal((await snooze(t, "000000000000000000000000", inHours(5))).status, 404);
    assert.equal((await t.api(`/mail/messages/${m.id}/unsnooze`, { method: "POST", json: {} })).status, 404, "not snoozed");
    await t.api("/mail/done", { method: "POST", json: { ids: [m.id] } });
    assert.equal((await snooze(t, m.id, inHours(5))).status, 404, "done mail is not snoozed");
    assert.ok(refuseToolCall("POST", `/mail/messages/${m.id}/snooze`));
    assert.ok(refuseToolCall("POST", `/mail/messages/${m.id}/unsnooze`));
  } finally { done(t); }
});

test("mail snooze: a snoozed mail stays kept while iCloud has it in the Inbox, and the refresh job wakes it", async () => {
  const { t } = await setUp();
  try {
    const m = await gutters(t);
    await snooze(t, m.id, inHours(1));
    await refreshMail(t.hub);
    assert.equal((await gutters(t)).state, "snoozed");
    await refreshMail(t.hub, {}, new Date(Date.now() + 2 * 3600_000));
    assert.equal((await gutters(t)).state, "inbox");
  } finally { done(t); }
});
