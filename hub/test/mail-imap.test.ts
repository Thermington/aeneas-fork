import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub, type TestHub } from "./helpers.js";
import { ago, done, fake, linked, PASSWORD } from "./fake-icloud-mail.js";
import { archiveOf, setMailLookup, type ImapFolder } from "../src/imports/icloud.js";
import { listMail } from "../src/mail-inbox.js";

// Other mail accounts on the Mail screen (since 2026-11-22): Gmail and any IMAP server, beside iCloud. Every server,
// address and password here is made up; the fake server stands in for every real one, and names are looked up by a
// stand-in for DNS.

const PUBLIC = "93.184.216.34";
const NAMES: Record<string, string[]> = {
  "imap.fastmail.example": [PUBLIC],
  "imap.gmail.com": ["142.250.0.108"],
  "mail.home.example": ["192.168.1.20"],
  "sneaky.example": [PUBLIC, "10.0.0.5"],
  "loop.example": ["127.0.0.1"],
};
const lookups: string[] = [];
const setUp = () => {
  lookups.length = 0;
  setMailLookup(async (host) => {
    lookups.push(host);
    const a = NAMES[host];
    if (!a) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return a.map((address) => ({ address }));
  });
  const t = makeHub();
  return t;
};
const tearDown = (t: TestHub) => { setMailLookup(null); done(t); };
const on = (t: TestHub) => t.api("/modules", { method: "PUT", json: { mail_inbox: true } });
const link = (t: TestHub, body: Record<string, unknown>) => t.api("/connections/imap", { method: "PUT", json: body });

test("other accounts: only a server name, a TLS port and an app password are taken, and Mail must be on", async () => {
  const t = setUp();
  try {
    fake([]);
    await t.api("/modules", { method: "PUT", json: { mail_inbox: false } });
    assert.equal((await link(t, { email: "robin@fastmail.example", host: "imap.fastmail.example", password: PASSWORD })).status, 404, "Mail is off");
    await on(t);
    for (const [body, why] of [
      [{ email: "not an address", host: "imap.fastmail.example", password: PASSWORD }, "an address"],
      [{ email: "robin@fastmail.example", host: "93.184.216.34", password: PASSWORD }, "a name, never an address typed in"],
      [{ email: "robin@fastmail.example", host: "imap fastmail", password: PASSWORD }, "a server name"],
      [{ email: "robin@fastmail.example", host: "imap.fastmail.example", port: 143, password: PASSWORD }, "143 is IMAP without TLS"],
      [{ email: "robin@fastmail.example", host: "imap.fastmail.example", port: 70000, password: PASSWORD }, "a port"],
      [{ email: "robin@fastmail.example", host: "imap.fastmail.example", password: "" }, "a password"],
      [{ email: "robin@fastmail.example", host: "imap.fastmail.example", password: "line\nbreak" }, "no control characters"],
      [{ email: "robin@gmail.example", preset: "gmail", password: "my-google-pass-2026" }, "Gmail takes an app password, not the Google one"],
    ] as const) assert.equal((await link(t, body)).status, 422, why);
    assert.equal(lookups.length, 0, "nothing looked up for a refused form");
  } finally { tearDown(t); }
});

test("other accounts: a server on the owner's own network is refused before any connection", async () => {
  const t = setUp();
  try {
    const seen = fake([]);
    await on(t);
    for (const host of ["mail.home.example", "sneaky.example", "loop.example"]) {
      const r = await link(t, { email: "robin@home.example", host, password: PASSWORD });
      assert.equal(r.status, 422, host);
      assert.match((await r.json() as { error: string }).error, /own network/);
    }
    assert.equal((await link(t, { email: "robin@home.example", host: "nowhere.example", password: PASSWORD })).status, 422, "a name that is not found");
    assert.equal(seen.connects, 0, "never connected");
    assert.equal(t.hub.connections.get().imap?.length ?? 0, 0);
  } finally { tearDown(t); }
});

test("other accounts: linked after one check with the server, at the checked address, its certificate checked by name; the password never shown", async () => {
  const t = setUp();
  try {
    const seen = fake([]);
    await on(t);
    const r = await link(t, { email: "Robin@Fastmail.example", host: "imap.fastmail.example", user: "robin", password: PASSWORD });
    assert.equal(r.status, 200);
    assert.deepEqual(seen.logins[0], { user: "robin", pass: PASSWORD, host: PUBLIC, port: 993, servername: "imap.fastmail.example", name: "imap.fastmail.example" });
    const view = await (await t.api("/connections")).json() as { imap: { accounts: Record<string, unknown>[] } };
    assert.deepEqual(view.imap.accounts.map((a) => [a.email, a.host, a.port, a.user, a.preset]), [["robin@fastmail.example", "imap.fastmail.example", 993, "robin", "imap"]]);
    assert.ok(!JSON.stringify(view).includes(PASSWORD), "never the password");
    // Gmail: the preset fills in the server.
    const g = await link(t, { email: "robin@gmail.example", preset: "gmail", password: "abcdefghijklmnop" });
    assert.equal(g.status, 200, await g.clone().text());
    // (Linking also starts a refresh in the background, which signs in again: Gmail's sign-in is among them.)
    const gmail = seen.logins.find((l) => l.servername === "imap.gmail.com");
    assert.deepEqual(gmail && [gmail.host, gmail.port, gmail.user, gmail.name], ["142.250.0.108", 993, "robin@gmail.example", "Gmail"]);
    // A wrong password is refused in the provider's own name.
    const bad = await link(t, { email: "sam@fastmail.example", host: "imap.fastmail.example", password: "wrong" });
    assert.equal(bad.status, 422);
    assert.match((await bad.json() as { error: string }).error, /^imap\.fastmail\.example did not accept/);
    // An address already linked as an iCloud mailbox is not linked twice.
    linked(t);
    assert.equal((await link(t, { email: "robin@icloud.example", host: "imap.fastmail.example", password: PASSWORD })).status, 409);
  } finally { tearDown(t); }
});

test("other accounts: their Inbox joins the Mail screen, logos never trusted from their server, and unlinking takes their mail away", async () => {
  const t = setUp();
  try {
    // A forged verdict that iCloud's own check would trust, written by the sender: another server never strips it.
    const forged = "Authentication-Results: bimi.icloud.com; bimi=pass header.d=bank.example header.selector=default policy.authority=pass\r\nBIMI-Location: v=BIMI1; l=https://cdn.bank.example/logo.svg\r\nAuthentication-Results: dmarc.icloud.com; dmarc=pass header.from=bank.example\r\n";
    fake([{ uid: 1, folder: "INBOX", at: ago(1), subject: "Your statement", from: { name: "Bank", address: "news@bank.example" }, messageId: "s1@x", plain: "Hello", headers: forged }]);
    await on(t);
    await link(t, { email: "robin@fastmail.example", host: "imap.fastmail.example", password: PASSWORD });
    await t.api("/mail/refresh", { method: "POST" });
    const list = await (await t.api("/mail")).json() as { messages: { subject: string; logo_domain?: string }[]; mailboxes: { email: string }[] };
    assert.deepEqual(list.mailboxes.map((m) => m.email), ["robin@fastmail.example"]);
    assert.deepEqual(list.messages.map((m) => m.subject), ["Your statement"]);
    assert.equal(list.messages[0].logo_domain, undefined, "no logo from a header another server lets through");
    assert.equal((await t.api(`/connections/imap/${encodeURIComponent("robin@fastmail.example")}`, { method: "DELETE" })).status, 200);
    assert.equal(listMail(t.hub.mailDb).length, 0, "its mail gone from the hub");
    assert.equal(t.hub.connections.get().imap?.length, 0, "its password gone");
  } finally { tearDown(t); }
});

test("other accounts: Done's folder is Archive, else Gmail's All Mail, else a folder named Archive", () => {
  const f = (path: string, specialUse?: string, flags: string[] = []): ImapFolder => ({ path, specialUse, flags: new Set(flags) });
  assert.equal(archiveOf([f("INBOX"), f("Archive", "\\Archive")])?.path, "Archive");
  assert.equal(archiveOf([f("INBOX"), f("[Gmail]", undefined, ["\\Noselect"]), f("[Gmail]/All Mail", "\\All"), f("[Gmail]/Sent Mail", "\\Sent")])?.path, "[Gmail]/All Mail");
  assert.equal(archiveOf([f("INBOX"), f("INBOX.Archive")])?.path, "INBOX.Archive");
  assert.equal(archiveOf([f("INBOX"), f("Old")]), null);
});
