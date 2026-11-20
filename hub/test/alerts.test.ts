import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { ALERT_KINDS, type AlertView } from "../src/alerts.js";
import { refuseToolCall } from "../src/ai/api-guard.js";

// Each kind of alert switched on or off on its own (alerts.ts): one setting for every device, held back at the hub.

const alerts = async (t: ReturnType<typeof makeHub>) => ((await (await t.api("/modules")).json()) as { alerts: AlertView[] }).alerts;
const put = (t: ReturnType<typeof makeHub>, body: unknown) => t.api("/modules/alerts", { method: "PUT", body: JSON.stringify(body) });

test("alerts: every kind is on to start with, and each is switched off and on by itself", async () => {
  const t = makeHub();
  try {
    assert.deepEqual((await alerts(t)).map((a) => [a.id, a.on]), ALERT_KINDS.map((k) => [k.id, true]));
    assert.deepEqual(ALERT_KINDS.map((k) => k.id).sort(), ["activity", "digest", "disk", "mail", "monitor", "quiz", "reminder", "sensor"]);
    const res = await put(t, { mail: false, quiz: false });
    assert.equal(res.status, 200);
    const now = ((await res.json()) as { alerts: AlertView[] }).alerts;
    assert.deepEqual(now.filter((a) => !a.on).map((a) => a.id).sort(), ["mail", "quiz"]);
    assert.equal(t.hub.alerts.on("reminder"), true);
    assert.equal(t.hub.alerts.on("mail"), false);
    await put(t, { mail: true });
    assert.deepEqual((await alerts(t)).filter((a) => !a.on).map((a) => a.id), ["quiz"]);
    // Kept in its own file, which is one of the settings files a backup carries.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.hub.cfg.dataDir, "alerts.json"), "utf8")), { quiz: false });
    // A kind the hub does not list (a newer hub's, an older file) is on.
    assert.equal(t.hub.alerts.on("something-new"), true);
  } finally { t.cleanup(); }
});

test("alerts: an unknown kind or a value that is not true or false is refused and nothing is saved", async () => {
  const t = makeHub();
  try {
    assert.equal((await put(t, { mail: false, nonsense: false })).status, 422);
    assert.equal((await put(t, { mail: "no" })).status, 422);
    assert.ok((await alerts(t)).every((a) => a.on));
  } finally { t.cleanup(); }
});

test("alerts: a switched-off kind is held back from the live stream; the others and the hub's own listeners still get theirs", async () => {
  const t = makeHub();
  try {
    await put(t, { mail: false });
    const heard: string[] = [];
    const off = t.hub.bus.on("notify", (e) => { heard.push(e.kind); });
    const res = await t.api("/live");
    const reader = res.body!.getReader();
    const text = new TextDecoder();
    let got = "";
    // One read waits at a time: a read given up on would swallow the next event.
    let pending: Promise<{ done: boolean; value?: Uint8Array }> | null = null;
    const readFor = async (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        pending ??= reader.read();
        const next = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, until - Date.now())))]);
        if (!next) break;
        pending = null;
        if (next.done) break;
        got += text.decode(next.value);
      }
    };
    await readFor(150);
    t.hub.bus.emit("notify", { id: "mail:1", kind: "mail", title: "Alex: Gutters", at: new Date().toISOString() });
    t.hub.bus.emit("notify", { id: "disk:1", kind: "disk", title: "The hub's disk is almost full", at: new Date().toISOString() });
    await readFor(400);
    await reader.cancel();
    off();
    assert.ok(got.includes("almost full"), "the disk alert reached the device");
    assert.ok(!got.includes("Gutters"), "the mail alert did not");
    assert.deepEqual(heard, ["mail", "disk"], "the hub's own listeners hear both");
  } finally { t.cleanup(); }
});

test("alerts: the assistant cannot switch them", () => {
  assert.ok(refuseToolCall("PUT", "/modules/alerts"), "refused");
  assert.equal(refuseToolCall("GET", "/modules"), null);
});
