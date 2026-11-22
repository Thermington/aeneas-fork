import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Endpoint, EndpointAddr, RelayMode } from "@number0/iroh";
import { deviceKey, makeHub, TOKEN } from "./helpers.js";
import { relayInTestHands } from "./iroh-fake.js";
import { chooseLink, currentMethod, DirectLink, LINK_ALPN, linkAvailability, readLinkFile, relayOwner } from "../src/link.js";
import { pairingLinks } from "../src/setup.js";

const ALPN = Array.from(Buffer.from(LINK_ALPN));

/** One HTTP request over a fresh stream of `conn`, answered in full. */
async function over(conn: import("@number0/iroh").Connection, pathName: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const bi = await conn.openBi();
  const head = Object.entries({ host: "hub", connection: "close", ...headers }).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  await bi.send.writeAll(Array.from(Buffer.from(`GET ${pathName} HTTP/1.1\r\n${head}\r\n`)));
  const raw = Buffer.from(await bi.recv.readToEnd(1 << 20)).toString();
  const [top, ...rest] = raw.split("\r\n\r\n");
  let body = rest.join("\r\n\r\n");
  if (/transfer-encoding: chunked/i.test(top)) body = body.replace(/(^|\r\n)[0-9a-f]+\r\n/gi, "").replace(/\r\n$/, "");
  return { status: Number(top.split(" ")[1]), body };
}

test("link: Direct link requests reach the hub as a remote device, never as this machine", async () => {
  const t = makeHub();
  const link = new DirectLink(t.hub.cfg, t.app.fetch, undefined, { noRelay: true });
  const cli = await (() => { const b = Endpoint.builder(); b.applyMinimal(); b.relayMode(RelayMode.disabled()); return b.bind(); })();
  try {
    const st = await link.start();
    assert.equal(st.state, "online", st.error);
    // The key is kept, owner-only, next to the other keys: the same hub key after a restart.
    assert.ok(fs.existsSync(t.hub.cfg.linkKeyFile));
    const ep = link.endpoint()!;
    const addrs = ep.boundSockets().filter((a) => a.startsWith("0.0.0.0:") || a.startsWith("127.")).map((a) => a.replace(/^0\.0\.0\.0/, "127.0.0.1"));
    const conn = await cli.connect(new EndpointAddr(ep.id(), null, addrs), ALPN);
    // The main key, which this machine itself may use, is refused over the link.
    const main = await over(conn, "/setup", { authorization: `Bearer ${TOKEN}` });
    assert.equal(main.status, 403, main.body);
    // A paired device's own key works.
    const key = await deviceKey(t);
    const dev = await over(conn, "/setup", { authorization: `Bearer ${key}` });
    assert.equal(dev.status, 200, dev.body);
    assert.ok(JSON.parse(dev.body).owner !== undefined);
    // No key at all is refused.
    assert.equal((await over(conn, "/setup")).status, 401);
    const id = ep.id().toString();
    await link.stop();
    assert.equal(link.status().state, "off");
    const again = await link.start();
    assert.equal(again.id, id, "the hub keeps its key across restarts");
  } finally {
    await cli.close();
    await link.stop();
    t.cleanup();
  }
});

test("link: methods this install cannot offer say how to get them; the choice is kept", async () => {
  const t = makeHub();
  try {
    assert.equal(currentMethod(t.hub.cfg), null, "nothing chosen and nothing set up: no method assumed");
    const a = linkAvailability(t.hub.cfg);
    assert.equal(a.direct.available, true);
    assert.equal(a.tailscale.available, false);
    assert.match(a.tailscale.how!, /installer again/);
    const r = await chooseLink(t.hub.cfg, "tailscale");
    assert.equal(r.ok, false);
    assert.deepEqual(await chooseLink(t.hub.cfg, "carrier pigeon"), { ok: false, status: 422, error: "method is direct, tailscale or home" });
    t.hub.cfg.publicUrl = "https://hub.tail1234.ts.net";
    assert.equal(currentMethod(t.hub.cfg), "tailscale", "a Tailscale install shows as Tailscale");
    assert.equal((await chooseLink(t.hub.cfg, "tailscale")).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.hub.cfg.dataDir, "link.json"), "utf8")).method, "tailscale");
    // The route says the same.
    const view = await (await t.api("/setup/link")).json() as { method: string; options: Record<string, { available: boolean }> };
    assert.equal(view.method, "tailscale");
    const bad = await t.api("/setup/link", { method: "PUT", json: { method: "home" } });
    assert.equal(bad.status, 409);
    // Pairing on a Tailscale hub carries no Direct link fields.
    const p = pairingLinks(t.hub, "https://hub.tail1234.ts.net", "iPhone");
    assert.doesNotMatch(p.app, /node=|relay=/);
  } finally { t.cleanup(); }
});

test("link: the relay's owner is said plainly", () => {
  assert.match(relayOwner("https://use1-1.relay.n0.iroh.link./")!, /^n0/);
  assert.equal(relayOwner("https://relay.example.org/"), "relay.example.org");
});

test("link: a stop while the Direct link is still starting wins (a choice changed during start-up)", async () => {
  const t = makeHub();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // iroh as loaded, held at the import until the stop has come.
  const link = new DirectLink(t.hub.cfg, t.app.fetch, async () => { await gate; return import("@number0/iroh"); }, { noRelay: true });
  try {
    const starting = link.start();
    assert.equal(link.status().state, "starting");
    await link.stop();
    release();
    await starting;
    assert.equal(link.status().state, "off");
    assert.equal(link.endpoint(), null);
  } finally {
    await link.stop();
    t.cleanup();
  }
});

test("link: an answer is all there for a client that reads it late (no reset after a clean finish)", async () => {
  const t = makeHub();
  const link = new DirectLink(t.hub.cfg, t.app.fetch, undefined, { noRelay: true });
  const cli = await (() => { const b = Endpoint.builder(); b.applyMinimal(); b.relayMode(RelayMode.disabled()); return b.bind(); })();
  try {
    await link.start();
    const ep = link.endpoint()!;
    const addrs = ep.boundSockets().filter((a) => a.startsWith("0.0.0.0:") || a.startsWith("127.")).map((a) => a.replace(/^0\.0\.0\.0/, "127.0.0.1"));
    const conn = await cli.connect(new EndpointAddr(ep.id(), null, addrs), ALPN);
    const key = await deviceKey(t);
    const bi = await conn.openBi();
    // HTTP/1.0 and the request side finished at once, as the apps send it.
    await bi.send.writeAll(Array.from(Buffer.from(`GET /setup HTTP/1.0\r\nhost: hub\r\nauthorization: Bearer ${key}\r\n\r\n`)));
    await bi.send.finish();
    await new Promise((r) => setTimeout(r, 300));
    const raw = Buffer.from(await bi.recv.readToEnd(1 << 20)).toString();
    assert.match(raw, /^HTTP\/1\.1 200/);
    assert.ok(JSON.parse(raw.split("\r\n\r\n")[1]).owner !== undefined);
  } finally {
    await cli.close();
    await link.stop();
    t.cleanup();
  }
});

test("Direct link: a start that fails for a passing reason is tried again until it works", async () => {
  const t = makeHub();
  let calls = 0;
  const link = new DirectLink(t.hub.cfg, t.app.fetch, async () => {
    calls++;
    if (calls === 1) throw new Error("no relay answered in 30 seconds (is this computer online?)");
    return import("@number0/iroh");
  }, { noRelay: true, retryMs: [50] });
  try {
    const first = await link.start();
    assert.equal(first.state, "error");
    assert.ok(first.retry_at, "says when it tries again");
    for (let i = 0; i < 100 && link.status().state !== "online"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(link.status().state, "online");
    assert.equal(calls, 2);
  } finally {
    await link.stop();
    t.cleanup();
  }
});

/** A client endpoint with no relay, connected straight to `link`'s endpoint on this machine. */
async function connectDirect(link: DirectLink, cli: Endpoint) {
  const ep = link.endpoint()!;
  const addrs = ep.boundSockets().filter((a) => a.startsWith("0.0.0.0:") || a.startsWith("127.")).map((a) => a.replace(/^0\.0\.0\.0/, "127.0.0.1"));
  return cli.connect(new EndpointAddr(ep.id(), null, addrs), ALPN);
}

test("Direct link: with no relay answering (no internet), it starts anyway, serves devices, and takes the relay once it answers", async () => {
  const t = makeHub();
  const relay = relayInTestHands("https://relay.example.org/");
  const link = new DirectLink(t.hub.cfg, t.app.fetch, relay.load, { onlineMs: 50, retryMs: [20] });
  const cli = await (() => { const b = Endpoint.builder(); b.applyMinimal(); b.relayMode(RelayMode.disabled()); return b.bind(); })();
  try {
    const st = await link.start();
    assert.equal(st.state, "online", st.error);
    assert.equal(st.relay_ok, false, "no relay answered");
    assert.equal(st.relay, undefined, "none known yet");
    assert.equal(st.retry_at, undefined, "not a failure");
    assert.equal(readLinkFile(t.hub.cfg.dataDir).relay, undefined, "a relay is written only once one answered");
    // Devices that reach the hub straight (a home network with the internet down) are served now.
    const key = await deviceKey(t);
    const dev = await over(await connectDirect(link, cli), "/setup", { authorization: `Bearer ${key}` });
    assert.equal(dev.status, 200, dev.body);
    relay.answer();
    for (let i = 0; i < 100 && !link.status().relay_ok; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(link.status().relay_ok, true);
    assert.equal(link.status().relay, "https://relay.example.org/");
    assert.equal(link.status().relay_by, "relay.example.org");
    assert.equal(readLinkFile(t.hub.cfg.dataDir).relay, "https://relay.example.org/", "the first relay that answered is kept");
  } finally {
    await cli.close();
    await link.stop();
    t.cleanup();
  }
});

test("Direct link: a kept relay that does not answer is still the one shown and kept; a stop ends the waiting", async () => {
  const t = makeHub();
  fs.writeFileSync(path.join(t.dir, "link.json"), JSON.stringify({ method: "direct", relay: "https://kept.example.net/" }));
  const relay = relayInTestHands("https://other.example.org/");
  const link = new DirectLink(t.hub.cfg, t.app.fetch, relay.load, { onlineMs: 30, retryMs: [10] });
  try {
    const st = await link.start();
    assert.deepEqual([st.state, st.relay, st.relay_ok], ["online", "https://kept.example.net/", false]);
    await link.stop();
    // The relay answering after the stop changes nothing: the background asking ended with the link.
    relay.answer();
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual([link.status().state, link.status().relay_ok], ["off", false]);
    assert.equal(readLinkFile(t.hub.cfg.dataDir).relay, "https://kept.example.net/");
  } finally {
    await link.stop();
    t.cleanup();
  }
});

test("Direct link is offered only where its library has a build: not on an Intel Mac", async () => {
  const { directLinkRuns } = await import("../src/link.js");
  assert.equal(directLinkRuns("darwin", "arm64"), true);
  assert.equal(directLinkRuns("darwin", "x64"), false, "an Intel Mac has no build: the hub could never start it");
  assert.equal(directLinkRuns("linux", "x64"), true);
  assert.equal(directLinkRuns("linux", "arm64"), true);
  assert.equal(directLinkRuns("linux", "arm"), true);
  assert.equal(directLinkRuns("win32", "x64"), true);
  assert.equal(directLinkRuns("win32", "arm64"), true);
  assert.equal(directLinkRuns("linux", "ia32"), false);
  assert.equal(directLinkRuns("freebsd", "x64"), false);
});

test("Direct link: a library that cannot load says why plainly, and on Windows names the Visual C++ runtime", async () => {
  const { directLoadFailure } = await import("../src/link.js");
  // What iroh's loader throws on a Windows PC without vcruntime140.dll (its cause holds Windows' own words).
  const napi = "Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.";
  const win = directLoadFailure(napi, "win32");
  assert.match(win ?? "", /Microsoft Visual C\+\+ runtime/);
  assert.match(win ?? "", /Run the hub installer again/);
  assert.doesNotMatch(win ?? "", /npm|package-lock/, "not npm's advice, which does not help");
  assert.match(directLoadFailure("The specified module could not be found.\r\n\\\\?\\C:\\x\\iroh.win32-x64-msvc.node", "win32") ?? "", /Visual C\+\+/);
  assert.equal(directLoadFailure(napi, "linux"), "Direct link cannot run on this system (Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again after removing both package-lock.json and node_modules directory.)");
  assert.match(directLoadFailure("Cannot find module '@number0/iroh'", "darwin") ?? "", /^Direct link cannot run on this system/);
  // A passing failure (no network yet) is not one of these: it is tried again.
  assert.equal(directLoadFailure("failed to bind: address in use", "win32"), null);
});

test("Direct link: a library that cannot load is not tried again, and the status says what to do", async () => {
  const t = makeHub();
  const link = new DirectLink(t.hub.cfg, t.app.fetch, async () => { throw new Error("Cannot find native binding. npm has a bug"); }, { noRelay: true, retryMs: [10] });
  try {
    const s = await link.start();
    assert.equal(s.state, "error");
    assert.ok(s.error && s.error.length > 0);
    assert.equal(s.retry_at, undefined, "no retry: it cannot load until something on the computer changes");
  } finally {
    await link.stop();
    t.cleanup();
  }
});
