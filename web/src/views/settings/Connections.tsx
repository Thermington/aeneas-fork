import { useCallback, useEffect, useState } from "react";
import { engine } from "../../sync/engine";
import type { AtlassianConnection, AtlassianSpace, CalendarSyncView, Connections as ConnectionsView, GmailAccount, GoogleConnection, ICloudConnection, ImapConnection, KeePassEntry, PasswordManagerProvider, PasswordManagerStatus, PasswordManagerView } from "../../sync/api";
import { spacesChanged } from "../../lib/wiki";
import { fmtDateTime } from "../../lib/time";
import { META } from "../../sync/db";
import { useHubReady, useMeta, useSyncState } from "../../sync/hooks";
import { SubPage, errorText } from "./common";
import { isTauri, openExternal } from "../../tauri/bridge";
import { useModules } from "../../lib/modules";
import { OwnKeyGuide } from "./OwnKeyGuide";

type Msg = { ok: boolean; text: string } | null;

/** One line for the Settings list: which accounts are linked. */
export function connectionsSummary(c: ConnectionsView | null): string {
  if (!c) return "Gmail, iCloud Mail, Steam, Letterboxd, Confluence, Apple Health";
  const on = [c.google?.accounts.length && "Gmail", c.icloud?.accounts.length && "iCloud Mail", c.imap?.accounts.length && "Other mail", c.steam.connected && "Steam", c.letterboxd.connected && "Letterboxd", c.atlassian?.connected && "Confluence", c.health.last_import && "Apple Health"].filter(Boolean);
  return on.length ? on.join(", ") : "None linked yet";
}

/**
 * The hub's connections. Loads again when the hub connection comes up (a page opened directly, or after a reload, is
 * drawn before it is ready), and says why when the hub cannot answer instead of showing Loading for ever.
 */
export function useConnections(): [ConnectionsView | null, () => void, string] {
  const sync = useSyncState();
  const [c, setC] = useState<ConnectionsView | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    const client = engine.client;
    if (!client) return;
    client.connections().then((v) => { setC(v); setErr(""); }, (e) => setErr(errorText(e)));
  }, []);
  useEffect(load, [load, sync.status]);
  return [c, load, err];
}

const when = (iso: string | null | undefined) => (iso ? fmtDateTime(iso) : "never");

function Status({ msg }: { msg: Msg }) {
  return msg ? <div className={msg.ok ? "ok small" : "error small"} role="status">{msg.text}</div> : null;
}

function Steam({ c, reload }: { c: ConnectionsView["steam"]; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const client = engine.client;
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      reload();
      setBusy(false);
    }
  };
  // While Steam's page is open in the browser, look for the link to land.
  useEffect(() => {
    if (!waiting || !client) return;
    const started = Date.now();
    const t = setInterval(() => {
      void client.connections().then((v) => {
        if (v.steam.connected) {
          setWaiting(false);
          setMsg({ ok: true, text: `Linked as ${v.steam.persona ?? v.steam.steam_id}, ${v.steam.games} games.` });
          reload();
        } else if (Date.now() - started > 5 * 60_000) setWaiting(false);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, client, reload]);
  const signIn = () =>
    void run(async () => {
      const { url } = await client!.steamSignIn("web");
      await openExternal(url);
      setWaiting(true);
      return "Sign in on Steam's page; this updates by itself when you are back.";
    });
  return (
    <section className="card col">
      <h2>Steam</h2>
      {c.connected ? (
        <>
          <div>
            Linked to <strong>{c.persona || c.steam_id}</strong>, {c.games} games. Last read {when(c.last_sync)}; it reads again every 6 hours.
          </div>
          {c.last_error && <div className="error small">{c.last_error}</div>}
          <div className="row">
            <button type="button" className="primary" disabled={busy || !client} onClick={() => void run(async () => { const r = await client!.syncSteam(); return `${r.games} games: ${r.created} new, ${r.updated} changed.`; })}>
              {busy ? "Reading" : "Read now"}
            </button>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm("Unlink Steam? The games stay.") && void run(async () => { await client!.disconnectSteam(); return "Unlinked. The games stay."; })}>
              Unlink
            </button>
          </div>
        </>
      ) : c.hub_key ? (
        <>
          <div className="muted small">Sign in on Steam's own page. The app learns only which account is yours; your Steam password never reaches it. Your profile's Game details need to be public.</div>
          <div>
            <button type="button" className="primary" disabled={busy || waiting || !client} onClick={signIn}>
              {waiting ? "Waiting for Steam" : "Sign in with Steam"}
            </button>
          </div>
        </>
      ) : (
        <OwnKeyGuide service="steam" onDone={reload} />
      )}
      <Status msg={msg} />
    </section>
  );
}

function Letterboxd({ c, reload }: { c: ConnectionsView["letterboxd"]; reload: () => void }) {
  const [user, setUser] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const client = engine.client;
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
      reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card col">
      <h2>Letterboxd</h2>
      {c.connected ? (
        <>
          <div>
            Diary of <strong>{c.username}</strong>, {c.films} films here. Read {when(c.last_sync)}; new entries come in every hour.
          </div>
          {c.last_error && <div className="error small">{c.last_error}</div>}
          <div className="row">
            <button type="button" className="primary" disabled={busy || !client} onClick={() => void run(async () => { const r = await client!.syncLetterboxd(); return `${r.entries} diary entries: ${r.created} new films, ${r.updated} changed.`; })}>
              {busy ? "Reading" : "Read diary now"}
            </button>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => void run(async () => { await client!.disconnectLetterboxd(); return "Unlinked. The films stay."; })}>
              Unlink
            </button>
          </div>
        </>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => { const r = await client!.connectLetterboxd(user.trim()); return `Linked. ${r.sync.entries} recent diary entries read.`; });
          }}
        >
          <input placeholder="Letterboxd username" aria-label="Letterboxd username" value={user} onChange={(e) => setUser(e.target.value)} style={{ flex: 1 }} />
          <button type="submit" className="primary" disabled={busy || !client || !user.trim()}>
            {busy ? "Linking" : "Link diary"}
          </button>
        </form>
      )}
      <div className="muted small">Everything you log on Letterboxd comes in by itself within the hour, starting from your 50 most recent diary entries.</div>
      <Status msg={msg} />
    </section>
  );
}

/** Confluence for the game design wiki: the hub's own Atlassian app once, then Sign in with Atlassian and a choice of spaces. */
function Confluence({ c, reload }: { c: AtlassianConnection; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [spaces, setSpaces] = useState<AtlassianSpace[] | null>(null);
  const [spacesErr, setSpacesErr] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const client = engine.client;
  const connected = c.connected;
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      reload();
      setBusy(false);
    }
  };
  const loadSpaces = useCallback(() => {
    if (!client) return;
    setSpacesErr("");
    client.atlassianSpaces().then(
      (r) => {
        setSpaces(r.spaces);
        setChosen(new Set(r.spaces.filter((s) => s.mirrored).map((s) => s.key)));
      },
      (e) => setSpacesErr(errorText(e)),
    );
  }, [client]);
  useEffect(() => {
    if (connected) loadSpaces();
    else setSpaces(null);
  }, [connected, loadSpaces]);
  // While Atlassian's page is open in the browser, look for the link to land.
  useEffect(() => {
    if (!waiting || !client) return;
    const started = Date.now();
    const t = setInterval(() => {
      void client.connections().then((v) => {
        if (v.atlassian?.connected) {
          setWaiting(false);
          setMsg({ ok: true, text: `Linked to ${v.atlassian.site_name}. Choose the spaces to mirror.` });
          reload();
        } else if (Date.now() - started > 5 * 60_000) setWaiting(false);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, client, reload]);
  const signIn = () =>
    void run(async () => {
      const { url } = await client!.atlassianSignIn("web");
      await openExternal(url);
      setWaiting(true);
      return "Sign in on Atlassian's page; this updates by itself when you are back.";
    });
  const mirrored = c.connected ? c.spaces : [];
  return (
    <section className="card col">
      <h2>Confluence</h2>
      {c.connected ? (
        <>
          <div>
            Linked to <strong>{c.site_name}</strong>, {c.pages === 1 ? "1 page" : `${c.pages} pages`} in the wiki. Last read {when(c.last_sync)}; it reads again every hour.
          </div>
          {c.last_error && <div className="error small">{c.last_error}</div>}
          <div className="col" role="group" aria-label="Spaces to mirror" style={{ gap: 0 }}>
            <div className="muted small">Spaces to mirror into the wiki</div>
            {spacesErr && <div className="error small">{spacesErr}</div>}
            {!spaces && !spacesErr && <div className="muted small">Loading spaces</div>}
            {spaces && !spaces.length && <div className="muted small">This site has no spaces the account can read.</div>}
            {spaces?.map((s) => (
              <label key={s.key} className="toggle-row">
                <input
                  type="checkbox"
                  checked={chosen.has(s.key)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(s.key);
                    else next.delete(s.key);
                    setChosen(next);
                  }}
                />
                <span>
                  {s.name} <span className="muted small">{s.key}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !client || !spaces || !spacesChanged(chosen, mirrored)}
              onClick={() =>
                void run(async () => {
                  const r = await client!.setAtlassianSpaces([...chosen]);
                  loadSpaces();
                  return chosen.size ? `Saved. ${r.sync.pages} pages from ${r.sync.spaces} ${r.sync.spaces === 1 ? "space" : "spaces"}.` : "Saved. No spaces are mirrored now.";
                })
              }
            >
              Save spaces
            </button>
            <button type="button" disabled={busy || !client || !mirrored.length} onClick={() => void run(async () => { const r = await client!.syncConfluence(); return `${r.pages} pages: ${r.updated} changed, ${r.removed} removed, ${r.images} images.`; })}>
              {busy ? "Reading" : "Sync now"}
            </button>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm("Unlink Confluence? Its pages leave the wiki; the repo docs stay.") && void run(async () => { await client!.disconnectAtlassian(); return "Unlinked. The Confluence pages left the wiki."; })}>
              Unlink
            </button>
          </div>
        </>
      ) : c.app ? (
        <>
          <div className="muted small">Sign in on Atlassian's own page and choose the spaces to mirror into the wiki. The app asks to read only; your Atlassian password never reaches it.</div>
          <div>
            <button type="button" className="primary" disabled={busy || waiting || !client} onClick={signIn}>
              {waiting ? "Waiting for Atlassian" : "Sign in with Atlassian"}
            </button>
          </div>
        </>
      ) : (
        <OwnKeyGuide service="atlassian" onDone={reload} />
      )}
      <Status msg={msg} />
    </section>
  );
}

/** What one mailbox's mail came to, in a line. */
/** "17:00" as "5 PM", "12:00" as "noon". */
function clock(hm: string): string {
  const [h, m] = hm.split(":").map(Number);
  if (h === 12 && m === 0) return "noon";
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

export function mailLine(a: GmailAccount): string {
  const n = (x: number, one: string, many: string) => (x === 1 ? `1 ${one}` : `${x} ${many}`);
  const filed = [a.filed.renewals && n(a.filed.renewals, "renewal", "renewals"), a.filed.pet && n(a.filed.pet, "pet record", "pet records"), a.filed.events && n(a.filed.events, "appointment", "appointments")].filter(Boolean);
  const left = a.to_read ? `, ${a.to_read} still to read` : "";
  return `${filed.length ? `Filed ${filed.join(", ")}` : "Nothing filed yet"} from ${n(a.read, "message", "messages")} read${left}.`;
}

/** Gmail, read-only: the hub's own Google app once, then Sign in with Google for each mailbox. */
function Gmail({ c, reload }: { c: GoogleConnection; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const client = engine.client;
  const linked = c.accounts.length;
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      reload();
      setBusy(false);
    }
  };
  // While Google's page is open in the browser, look for the new mailbox to land.
  useEffect(() => {
    if (!waiting || !client) return;
    const started = Date.now();
    const t = setInterval(() => {
      void client.connections().then((v) => {
        if ((v.google?.accounts.length ?? 0) > linked) {
          setWaiting(false);
          setMsg({ ok: true, text: `Linked ${v.google!.accounts.at(-1)!.email}. Its mail is being read in the background.` });
          reload();
        } else if (Date.now() - started > 5 * 60_000) setWaiting(false);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, client, reload, linked]);
  const signIn = () =>
    void run(async () => {
      const { url } = await client!.googleSignIn("web");
      await openExternal(url);
      setWaiting(true);
      return "Choose the mailbox on Google's page; this updates by itself when you are back.";
    });
  return (
    <section className="card col">
      <h2>Gmail</h2>
      {c.accounts.map((a) => (
        <div key={a.email} className="col" style={{ gap: 2 }}>
          <div>
            <strong>{a.email}</strong>
          </div>
          <div className="small">{mailLine(a)}</div>
          <div className="muted small">Last checked {when(a.last_sync)}; it checks every 15 minutes.</div>
          {a.last_error && <div className="error small">{a.last_error}</div>}
          <div>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm(`Unlink ${a.email}? What was filed from its mail stays.`) && void run(async () => { await client!.disconnectGoogle(a.email); return `Unlinked ${a.email}.`; })}>
              Unlink
            </button>
          </div>
        </div>
      ))}
      {c.app ? (
        <>
          <div className="muted small">
            Receipts, renewal notices and vet mail fill in renewals and pets. The hub checks for new mail every 15 minutes and reads it {c.times?.length ? `at ${c.times.map(clock).join(", ")}` : "at set times"} when no game is using the GPU; Read now reads it right away.
            {c.waiting_for_gpu && <> Waiting: {c.waiting_for_gpu}.</>} Google is asked to let the hub read mail only; it never sends, changes or deletes any. The model on your hub reads it, and the mail itself is never kept.
          </div>
          <div className="row">
            <button type="button" className="primary" disabled={busy || waiting || !client} onClick={signIn}>
              {waiting ? "Waiting for Google" : linked ? "Add another mailbox" : "Sign in with Google"}
            </button>
            {linked > 0 && (
              <button type="button" disabled={busy || !client || c.reading} onClick={() => void run(async () => { await client!.readMailNow(); return "Reading the waiting mail now. It stops for any chat."; })}>
                {c.reading ? "Reading" : `Read now${c.accounts.reduce((t, a) => t + a.to_read, 0) ? ` (${c.accounts.reduce((t, a) => t + a.to_read, 0)} waiting)` : ""}`}
              </button>
            )}
          </div>
        </>
      ) : (
        <OwnKeyGuide service="google" onDone={reload} />
      )}
      <Status msg={msg} />
    </section>
  );
}

/**
 * iCloud Mail, read-only: each mailbox linked with an app-specific password made at account.apple.com. One link serves
 * Mail receipts and the Mail screen, whichever are on.
 */
function ICloudMail({ c, receipts, chat, reading, reload }: { c: ICloudConnection; receipts: boolean; chat: boolean; reading: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const client = engine.client;
  const waiting = c.accounts.reduce((t, a) => t + a.to_read, 0);
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      reload();
      setBusy(false);
    }
  };
  return (
    <section className="card col">
      <h2>iCloud Mail</h2>
      {c.accounts.map((a) => (
        <div key={a.email} className="col" style={{ gap: 2 }}>
          <div>
            <strong>{a.email}</strong>
          </div>
          {receipts && <div className="small">{mailLine(a)}</div>}
          {receipts && <div className="muted small">Last checked {when(a.last_sync)}; it checks every 15 minutes.</div>}
          {a.last_error && <div className="error small">{a.last_error}</div>}
          <div>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm(`Unlink ${a.email}? Its password is deleted from the hub and so is its mail on the Mail screen; what was filed from its mail stays.`) && void run(async () => (await client!.disconnectICloud(a.email)).message)}>
              Unlink
            </button>
          </div>
        </div>
      ))}
      {c.accounts.length > 0 && chat && (
        <div className="muted small">
          <a href="#/mail">Mail</a> shows this mailbox's Inbox, sorted into bundles. Read and unread are kept the same as in iCloud; Done moves a mail to Archive in iCloud, and Undo moves it back. Each message is kept on the hub while it is in your Inbox, never its attachments.
        </div>
      )}
      {c.accounts.length > 0 && receipts && (
        <>
          <div className="muted small">
            Receipts, renewal notices and vet mail fill in renewals and pets, read at the same times as Gmail. The hub only reads: folders are opened read-only and nothing is marked read, moved or deleted, and Junk, Trash, Drafts and Sent are skipped. The model on your hub reads it, and the mail itself is never kept.
          </div>
          <div className="row">
            <button type="button" disabled={busy || !client || reading} onClick={() => void run(async () => { await client!.icloudReadNow(); return "Reading the waiting mail now. It stops for any chat."; })}>
              {reading ? "Reading" : `Read now${waiting ? ` (${waiting} waiting)` : ""}`}
            </button>
          </div>
        </>
      )}
      <OwnKeyGuide service="icloud" onDone={reload} />
      <Status msg={msg} />
    </section>
  );
}

function Health({ c }: { c: ConnectionsView["health"] }) {
  return (
    <section className="card col">
      <h2>Apple Health</h2>
      <div>{c.last_import ? `${c.total} readings from Health, last sent ${when(c.last_import)}.` : "Nothing from Health yet."}</div>
      <div className="muted small">Health lives on the iPhone: turn it on in the iPhone app, Settings, Connections. It works both ways: weight, blood pressure, sleep, steps, workouts, caffeine and mood come in as logs, and what you log here (weight, blood pressure, caffeine, mood, timed activities) goes into Health. Browse it all under Health.</div>
    </section>
  );
}

/**
 * Calendar sync on the hub (Calendar accounts): an iCloud address's calendars kept in step with the app, both ways, so
 * every device has them. The password is the same app-specific one iCloud Mail uses, so an address linked there needs
 * none here.
 */
/**
 * Other mail accounts for the Mail screen (since 2026-11-22): Gmail, or any provider that offers IMAP and app
 * passwords. The hub checks the password with the server once and keeps it sealed; it is never shown again.
 */
function OtherMail({ c, reload }: { c: ImapConnection; reload: () => void }) {
  const client = engine.client;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [preset, setPreset] = useState<"gmail" | "imap">("gmail");
  const [email, setEmail] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try { setMsg({ ok: true, text: await f() }); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { reload(); setBusy(false); }
  };
  const ready = !!email.trim() && !!password.trim() && (preset === "gmail" || !!host.trim());
  return (
    <section className="card col">
      <h2>Other mail accounts</h2>
      <div className="muted small">
        Gmail, or any mail provider that offers IMAP and app passwords, shown in <a href="#/mail">Mail</a> beside iCloud. The hub signs in with an app password you make for it, never your account's own password, and keeps it only on your hub. Mail is handled as for iCloud: only what you open is marked read, and Done moves a mail to the account's Archive (Gmail's All Mail).
      </div>
      {c.accounts.map((a) => (
        <div key={a.email} className="col" style={{ gap: 2 }}>
          <div><strong>{a.email}</strong> <span className="muted small">{a.preset === "gmail" ? "Gmail" : `${a.host}:${a.port}`}{a.user !== a.email ? `, signs in as ${a.user}` : ""}</span></div>
          {a.last_error && <div className="error small">{a.last_error}</div>}
          <div>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm(`Unlink ${a.email}? Its password is deleted from the hub and so is its mail on the Mail screen; the mail itself stays with your provider.`) && void run(async () => (await client!.disconnectImap(a.email)).message)}>
              Unlink
            </button>
          </div>
        </div>
      ))}
      <form className="col" onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const base = { email: email.trim(), password: password.trim(), ...(user.trim() ? { user: user.trim() } : {}) };
          await client!.linkImap(preset === "gmail" ? { ...base, preset } : { ...base, preset, host: host.trim(), port: Number(port) || 993 });
          setPassword("");
          return "Linked. Its Inbox comes into Mail now.";
        });
      }}>
        <div className="row wrap" role="radiogroup" aria-label="Kind of account">
          <label className="toggle-row"><input type="radio" name="imap-preset" checked={preset === "gmail"} onChange={() => setPreset("gmail")} /> <span>Gmail</span></label>
          <label className="toggle-row"><input type="radio" name="imap-preset" checked={preset === "imap"} onChange={() => setPreset("imap")} /> <span>Another provider (IMAP)</span></label>
        </div>
        <div className="muted small">
          {preset === "gmail"
            ? <>Turn on 2-Step Verification for your Google Account, then make an app password named Aeneas at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>. Google shows it once, as 16 letters.</>
            : <>Your provider's help pages give its IMAP server and port, and where to make an app password. The hub connects with TLS only (most often port 993), and only to servers on the internet, never one on your own network.</>}
        </div>
        <label className="col small" style={{ gap: 2 }}>
          Email address
          <input type="email" autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder={preset === "gmail" ? "you@gmail.com" : "you@example.com"} />
        </label>
        {preset === "imap" && (
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="col small" style={{ gap: 2, flex: "1 1 220px" }}>
              IMAP server
              <input autoComplete="off" spellCheck={false} value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.example.com" />
            </label>
            <label className="col small" style={{ gap: 2, width: 90 }}>
              Port
              <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder="993" />
            </label>
          </div>
        )}
        {preset === "imap" && (
          <label className="col small" style={{ gap: 2 }}>
            Username (if it is not the address)
            <input autoComplete="off" spellCheck={false} value={user} onChange={(e) => setUser(e.target.value)} placeholder={email.trim() || "the address"} />
          </label>
        )}
        <label className="col small" style={{ gap: 2 }}>
          App password
          <input type="password" autoComplete="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={preset === "gmail" ? "abcd efgh ijkl mnop" : ""} />
        </label>
        <div><button type="submit" className="primary" disabled={busy || !client || !ready}>{busy ? "Checking" : "Link"}</button></div>
      </form>
      <Status msg={msg} />
    </section>
  );
}

function ICloudCalendar({ mailAccounts }: { mailAccounts: string[] }) {
  const client = engine.client;
  const ready = useHubReady();
  const [v, setV] = useState<CalendarSyncView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const load = useCallback(() => { void engine.client?.calendarSync().then(setV, (e) => setMsg({ ok: false, text: errorText(e) })); }, []);
  useEffect(load, [load, ready]);
  const run = async (f: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try { const t = await f(); if (t) setMsg({ ok: true, text: t }); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  if (!v) return null;
  const known = mailAccounts.includes(email.trim().toLowerCase());
  return (
    <section className="card col">
      <h2>iCloud Calendar</h2>
      <div className="muted small">
        Your iCloud calendars kept in step with Aeneas by the hub, both ways, so every device shows them: Windows, Android and the web too. Events from the calendars you choose come in, events you or the assistant add go to the calendar you pick, and edits and deletions travel both ways. Repeating events come in too; change those in iCloud. Work events never leave the hub.
      </div>
      {v.accounts.map((a) => {
        const chosen = a.calendars.filter((c) => c.chosen);
        const toggle = (url: string, on: boolean) => void run(async () => {
          const next = on ? [...chosen.map((c) => c.url), url] : chosen.map((c) => c.url).filter((u) => u !== url);
          setV(await client!.chooseCalendars(a.email, { chosen: next, ...(!on && a.target === url ? { target: null } : {}) }));
        });
        return (
          <div key={a.email} className="col" style={{ gap: 4 }}>
            <div><strong>{a.email}</strong></div>
            <div className="col" role="group" aria-label={`Calendars of ${a.email}`} style={{ gap: 0 }}>
              <div className="muted small">Calendars to keep in step</div>
              {a.calendars.map((c) => (
                <label key={c.url} className="toggle-row">
                  <input type="checkbox" checked={c.chosen} disabled={busy} onChange={(e) => toggle(c.url, e.target.checked)} />
                  <span>
                    {c.color && <span aria-hidden="true" style={{ display: "inline-block", width: 10, height: 10, borderRadius: 5, background: c.color, marginRight: 6 }} />}
                    {c.name}{!c.writable && <span className="muted small"> read only</span>}
                  </span>
                </label>
              ))}
            </div>
            <label className="col small" style={{ gap: 2 }}>
              New events made in Aeneas go to
              <select value={a.target ?? ""} disabled={busy} onChange={(e) => void run(async () => { setV(await client!.chooseCalendars(a.email, { target: e.target.value || null })); })}>
                <option value="">Keep them in the app</option>
                {a.calendars.filter((c) => c.writable).map((c) => <option key={c.url} value={c.url}>{c.name}</option>)}
              </select>
            </label>
            <div className="muted small">Last synced {when(a.last_sync)}; it syncs every 5 minutes, and soon after you change an event.</div>
            {a.last_error && <div className="error small">{a.last_error}</div>}
            <div className="row wrap">
              <button type="button" disabled={busy || !chosen.length} onClick={() => void run(async () => { const r = await client!.syncCalendarsNow(); setV(r); const err = r.results.find((x) => x.error)?.error; if (err) throw new Error(err); return "Synced."; })}>
                {busy ? "Syncing" : "Sync now"}
              </button>
              <button type="button" className="ghost danger" disabled={busy} onClick={() => confirm(`Stop keeping ${a.email}'s calendars in step? Its events stay in the app as they are; repeating ones are taken out.`) && void run(async () => { const r = await client!.stopCalendars(a.email); setV(r); return r.message; })}>
                Stop syncing
              </button>
            </div>
          </div>
        );
      })}
      {!v.accounts.length && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { setV(await client!.linkCalendars(email.trim(), password.trim() || undefined)); setPassword(""); return "Linked. Choose the calendars to keep in step."; }); }}>
          <div className="muted small">
            Apple has no sign-in for calendars, so the hub uses an app-specific password: at <a href="https://account.apple.com" target="_blank" rel="noreferrer">account.apple.com</a>, open Sign-In and Security, App-Specific Passwords, and make one named Aeneas. It is kept only on your hub and opens iCloud Mail, Contacts and Calendars; the hub uses it only for what you switch on. {mailAccounts.length > 0 && "An address already linked for iCloud Mail needs no new password."}
          </div>
          <label className="col small" style={{ gap: 2 }}>
            Apple Account address
            <input type="email" autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@icloud.com" />
          </label>
          <label className="col small" style={{ gap: 2 }}>
            {known ? "App-specific password (not needed: iCloud Mail has it)" : "App-specific password"}
            <input type="password" autoComplete="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="abcd-efgh-ijkl-mnop" />
          </label>
          <div><button type="submit" className="primary" disabled={busy || !email.trim() || (!known && !password.trim())}>{busy ? "Checking" : "Link"}</button></div>
        </form>
      )}
      <Status msg={msg} />
    </section>
  );
}

/** The plan as a calendar any app can subscribe to: task blocks, events, reminders and renewals. */
function CalendarFeed() {
  const hubUrl = useMeta<string>(META.hubUrl) ?? "";
  const [key, setKey] = useState("");
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState("");
  const ready = useHubReady();
  useEffect(() => { void engine.client?.feeds().then((f) => setKey(f.calendar.key)).catch(() => undefined); }, [ready]);
  if (!hubUrl || !key) return null;
  // The calendar key reads this feed and nothing else, so the link is safe in a calendar app that syncs it elsewhere.
  const https = `${hubUrl.replace(/\/+$/, "")}/calendar.ics?key=${encodeURIComponent(key)}`;
  const webcal = https.replace(/^https?:/, "webcal:");
  return (
    <section className="card col">
      <h2>Calendar</h2>
      <div className="muted small">
        Scheduled tasks, events, reminders and renewal dates as a calendar your calendar app keeps up to date by itself (work items stay out). The link's key only reads this calendar; New link ends the old one.
      </div>
      <div className="row wrap">
        <button type="button" className="primary" onClick={() => void (isTauri ? openExternal(webcal) : Promise.resolve(window.location.assign(webcal))).catch(() => undefined)}>
          Subscribe in calendar app
        </button>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(https).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            if (!confirm("Make a new calendar link? Calendar apps subscribed with the old one stop updating until you subscribe again.")) return;
            void engine.client?.rotateFeed("calendar").then((f) => { setKey(f.calendar.key); setMsg("New link made. Subscribe again with it."); }).catch((e) => setMsg(errorText(e)));
          }}
        >
          New link
        </button>
      </div>
      {msg && <div className="muted small">{msg}</div>}
    </section>
  );
}

/** The built-in vault's items: add one (a password left empty is made up), remove one, take the file to a KeePass app, or bring one in. */
function KeePassItems({ busy, run }: { busy: boolean; run: (f: () => Promise<string | void>) => Promise<void> }) {
  const client = engine.client;
  const [entries, setEntries] = useState<KeePassEntry[] | null>(null);
  const [title, setTitle] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState("");
  const [master, setMaster] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filePassword, setFilePassword] = useState("");
  const load = () => void client?.keepassEntries().then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  useEffect(load, [client]);
  const add = () => void run(async () => {
    await client!.putKeepassEntry({ title: title.trim(), username: username || undefined, password: password || undefined, url: url || undefined });
    const made = !password;
    setTitle(""); setUsername(""); setPassword(""); setUrl("");
    load();
    return made ? `${title.trim()} saved with a new random password.` : `${title.trim()} saved.`;
  });
  const download = () => void run(async () => {
    const blob = await client!.keepassFile();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "passwords.kdbx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const bringIn = () => void run(async () => {
    const bytes = new Uint8Array(await file!.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await client!.importKeepass(btoa(bin), filePassword);
    setFile(null); setFilePassword("");
    load();
    return `Your KeePass file is the vault now (${r.items} items). The old one is kept beside it on the hub. Allow the items the assistant may use below.`;
  });
  return (
    <div className="col">
      <strong className="small">In the vault</strong>
      {entries && !entries.length && <div className="muted small">Nothing yet. Add a login below.</div>}
      {entries?.map((e) => (
        <div key={e.title} className="row">
          <span className="grow">{e.title}{e.username ? <span className="muted"> {e.username}</span> : null}{e.url ? <span className="muted small"> {e.url}</span> : null}</span>
          <button type="button" className="ghost danger small" disabled={busy} onClick={() => confirm(`Remove ${e.title} from the vault?`) && void run(async () => { await client!.removeKeepassEntry(e.title); load(); return `${e.title} removed.`; })} aria-label={`Remove ${e.title}`}>Remove</button>
        </div>
      ))}
      <form className="col" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <div className="row wrap">
          <input className="grow" placeholder="Name, like NAS admin" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" aria-label="Item name" />
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" aria-label="Username" />
        </div>
        <div className="row wrap">
          <input className="grow" type="password" placeholder="Password (empty: make a strong one)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-label="Password" />
          <input placeholder="Address (optional)" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" aria-label="Address" />
        </div>
        <div><button type="submit" className="primary" disabled={busy || !title.trim()}>Add to the vault</button></div>
      </form>
      <div className="muted small">The vault is a KeePass file. Open it in KeePassXC, KeePassDX, Strongbox or KeePassium with its master password to see or change a password.</div>
      <div className="row wrap">
        <button type="button" disabled={busy} onClick={download}>Download the vault file</button>
        {master === null
          ? <button type="button" disabled={busy} onClick={() => void run(async () => { setMaster((await client!.keepassMaster()).password); })}>Show the master password</button>
          : <span className="row"><code>{master}</code><button type="button" className="ghost small" onClick={() => setMaster(null)}>Hide</button></span>}
      </div>
      <details>
        <summary className="small">Use a KeePass file you already have</summary>
        <div className="col">
          <input type="file" accept=".kdbx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="KeePass file" />
          <input type="password" placeholder="Its master password" value={filePassword} onChange={(e) => setFilePassword(e.target.value)} autoComplete="off" aria-label="Its master password" />
          <div><button type="button" disabled={busy || !file || !filePassword} onClick={bringIn}>Use this file</button></div>
        </div>
      </details>
    </div>
  );
}

const PM_NAMES: Record<PasswordManagerProvider, string> = { keepass: "Built-in vault", lastpass: "LastPass", "1password": "1Password", bitwarden: "Bitwarden" };

/**
 * LastPass, 1Password or Bitwarden (also a self-hosted Vaultwarden) through its CLI on the hub's machine (LastPass also
 * on another one it reaches, like a Mac already signed in), or the hub's own KeePass file for someone with no password
 * manager, so the assistant can use a password in a command without seeing it. Every item except the ones left out
 * here (the default), or only the ones chosen here, and the assistant learns only names.
 */
function PasswordManager({ c, reload }: { c: PasswordManagerView; reload: () => void }) {
  const client = engine.client;
  const [hosts, setHosts] = useState<Array<{ name: string; os: string; local: boolean }>>([]);
  const [provider, setProvider] = useState<PasswordManagerProvider>(c.provider ?? "keepass");
  const [server, setServer] = useState("");
  const [host, setHost] = useState(c.host ?? "");
  const [status, setStatus] = useState<PasswordManagerStatus | null>(null);
  const [email, setEmail] = useState(c.account ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    if (!client) return;
    void client.aiHosts().then((r) => setHosts(r.hosts.filter((h) => h.os !== "windows"))).catch(() => undefined);
  }, [client]);
  useEffect(() => {
    if (!client || !host) return;
    setStatus(null);
    void client.passwordManagerStatus(provider, host).then(setStatus).catch((e) => setMsg({ ok: false, text: errorText(e) }));
  }, [client, provider, host, c.linked, c.account]);
  const run = async (f: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const text = await f();
      if (text) setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setPassword("");
      setCode("");
      setToken("");
      reload();
      setBusy(false);
    }
  };
  const name = PM_NAMES[provider];
  const localOnly = provider !== "lastpass";
  const chosen = c.linked && c.provider === provider && (localOnly || c.host === host);
  const signedIn = chosen && !!status?.signed_in;
  const allow = (names: string[]) => void run(async () => { await client!.allowPasswordManagerItems(names); });
  const setAccess = (body: { access?: "all" | "chosen"; excluded?: string[] }) => void run(async () => { await client!.setPasswordManagerAccess(body); });
  return (
    <section className="card col">
      <h2>Password manager</h2>
      <div className="muted small">
        Lets the assistant use a password in a command on your machines without ever seeing it. Only the items you allow below are read, every command that uses one waits for your approval, and the value is hidden from what the command prints. No password manager? The built-in vault is a KeePass file the hub keeps, which any KeePass app opens.
      </div>
      <div className="row wrap">
        <select value={provider} onChange={(e) => setProvider(e.target.value as PasswordManagerProvider)} aria-label="Password manager">
          <option value="keepass">Built-in vault (KeePass, open source)</option>
          <option value="bitwarden">Bitwarden or Vaultwarden</option>
          <option value="1password">1Password</option>
          <option value="lastpass">LastPass</option>
        </select>
        {provider === "lastpass" && (
          <select value={host} onChange={(e) => setHost(e.target.value)} aria-label="Machine its CLI runs on">
            {hosts.map((h) => (
              <option key={h.name} value={h.name}>
                on {h.name}{h.local ? " (the hub)" : ""}
              </option>
            ))}
          </select>
        )}
        {!chosen && (
          <button type="button" className="primary" disabled={busy || !client || (!localOnly && !host)} onClick={() => void run(async () => { await client!.linkPasswordManager(provider, localOnly ? "" : host); return provider === "keepass" ? "The built-in vault is ready." : `${name}${localOnly ? "" : ` on ${host}`} chosen.`; })}>
            {provider === "keepass" ? "Make the vault" : "Use this"}
          </button>
        )}
      </div>
      {status && provider !== "keepass" && (
        <div className="small">
          {status.installed[provider] ? `${name} CLI is installed on ${status.host}` : `${name} CLI is not installed on ${status.host}`}
          {chosen && status.installed[provider] ? (signedIn ? `, signed in${status.account ? ` as ${status.account}` : ""}.` : ", not signed in.") : "."}
          {status.install_hint && !status.installed[provider] && provider !== "bitwarden" && <div className="muted">Install it there: <code>{status.install_hint}</code></div>}
          {!status.installed[provider] && provider === "bitwarden" && (
            <div><button type="button" disabled={busy || !client} onClick={() => void run(async () => { setStatus(await client!.installPasswordManager("bitwarden")); return "The Bitwarden CLI is installed."; })}>{busy ? "Installing..." : "Install the Bitwarden CLI"}</button></div>
          )}
        </div>
      )}
      {chosen && status?.installed.bitwarden && !signedIn && provider === "bitwarden" && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { await client!.signInPasswordManager({ email: email.trim(), password, code: code.trim() || undefined, server: server.trim() || undefined }); return "Signed in to Bitwarden."; }); }}>
          <div className="muted small">Your master password goes to Bitwarden's own CLI on the hub and is not kept; the app keeps only the session key it answers.</div>
          <input type="email" placeholder="Bitwarden email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" aria-label="Bitwarden email" />
          <input type="password" placeholder="Master password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" aria-label="Master password" />
          <input placeholder="Authenticator code, if you use one" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" aria-label="Authenticator code" />
          <input placeholder="Server, only for Vaultwarden or the EU cloud (https://...)" value={server} onChange={(e) => setServer(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Server address" />
          <div><button type="submit" className="primary" disabled={busy || !password}>Sign in</button></div>
        </form>
      )}
      {chosen && provider === "keepass" && status && !signedIn && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { await client!.signInPasswordManager({ password }); return "The vault opens."; }); }}>
          <div className="muted small">The vault file is there but its master password is not known here. Type it to open it.</div>
          <input type="password" placeholder="Master password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" aria-label="Master password" />
          <div><button type="submit" className="primary" disabled={busy || !password}>Open</button></div>
        </form>
      )}
      {chosen && provider === "keepass" && signedIn && <KeePassItems busy={busy} run={run} />}
      {chosen && status?.installed[provider] && !signedIn && provider === "lastpass" && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { await client!.signInPasswordManager({ email: email.trim(), password, code: code.trim() || undefined }); return "Signed in to LastPass."; }); }}>
          <div className="muted small">Your master password goes to LastPass's own CLI on {host} and is not kept by the app.</div>
          <input type="email" placeholder="LastPass email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" aria-label="LastPass email" />
          <input type="password" placeholder="Master password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" aria-label="Master password" />
          <input placeholder="Authenticator code, if you use one" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" aria-label="Authenticator code" />
          <div><button type="submit" className="primary" disabled={busy || !email.trim() || !password}>Sign in</button></div>
        </form>
      )}
      {chosen && status?.installed[provider] && !signedIn && provider === "1password" && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { await client!.signInPasswordManager({ token: token.trim() }); return "1Password linked."; }); }}>
          <div className="muted small">1Password's CLI signs in without you there through a service account: in 1Password, Developer, Service accounts, make one with read access to the vaults the assistant may use, and paste its token.</div>
          <input type="password" placeholder="ops_..." value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Service account token" />
          <div><button type="submit" className="primary" disabled={busy || !token.trim()}>Save token</button></div>
        </form>
      )}
      {signedIn && (c.access ?? "chosen") === "all" && (
        <div className="col">
          <strong className="small">Items the assistant may use</strong>
          <div className="row wrap">
            <label className="row small"><input type="radio" name="pm-access" checked onChange={() => {}} /> Every item, except the ones left out below</label>
            <label className="row small"><input type="radio" name="pm-access" checked={false} disabled={busy} onChange={() => setAccess({ access: "chosen" })} /> Only items I choose</label>
          </div>
          <div className="muted small">The assistant learns only item names, by searching, never a password, and every command that uses one waits for your approval. An item left out is never read, even if a command names it.</div>
          <strong className="small">Left out</strong>
          {!(c.excluded ?? []).length && <div className="muted small">Nothing yet. Search below to leave out items or whole folders.</div>}
          <div className="chips">
            {(c.excluded ?? []).map((n) => (
              <span key={n} className="chip">
                {n.endsWith("/") ? `Folder ${n}` : n}
                <button className="chip-x" disabled={busy} onClick={() => setAccess({ excluded: (c.excluded ?? []).filter((x) => x !== n) })} aria-label={`Let the assistant use ${n} again`}>{"\u00D7"}</button>
              </span>
            ))}
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { setFound((await client!.passwordManagerItems(q)).items); }); }}>
            <input className="grow" placeholder={`Search ${name} item names`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search item names" />
            <button type="submit" disabled={busy}>Search</button>
          </form>
          {found && (() => {
            const left = new Set(c.excluded ?? []);
            const folders = [...new Set(found.filter((n) => n.includes("/")).map((n) => n.slice(0, n.lastIndexOf("/") + 1)))].filter((f) => !left.has(f));
            return (
              <div className="chips">
                {folders.map((f) => (
                  <button key={f} type="button" className="chip" disabled={busy} onClick={() => setAccess({ excluded: [...(c.excluded ?? []), f] })} title="Leave out every item in this folder">
                    {"\u2212"} Folder {f}
                  </button>
                ))}
                {found.filter((n) => !left.has(n)).map((n) => (
                  <button key={n} type="button" className="chip" disabled={busy} onClick={() => setAccess({ excluded: [...(c.excluded ?? []), n] })} title="Leave this item out">
                    {"\u2212"} {n}
                  </button>
                ))}
                {!found.length && <span className="muted small">No items match.</span>}
              </div>
            );
          })()}
        </div>
      )}
      {signedIn && (c.access ?? "chosen") === "chosen" && (
        <div className="col">
          <strong className="small">Items the assistant may use</strong>
          {c.access && (
            <div className="row wrap">
              <label className="row small"><input type="radio" name="pm-access" checked={false} disabled={busy} onChange={() => setAccess({ access: "all" })} /> Every item, except the ones left out</label>
              <label className="row small"><input type="radio" name="pm-access" checked onChange={() => {}} /> Only items I choose</label>
            </div>
          )}
          {!c.allowed.length && <div className="muted small">None yet. Search below and allow the ones it should be able to use.</div>}
          <div className="chips">
            {c.allowed.map((n) => (
              <span key={n} className="chip">
                {n}
                <button className="chip-x" onClick={() => allow(c.allowed.filter((x) => x !== n))} aria-label={`Stop allowing ${n}`}>{"\u00D7"}</button>
              </span>
            ))}
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { setFound((await client!.passwordManagerItems(q)).items); }); }}>
            <input className="grow" placeholder={`Search ${name} item names`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search item names" />
            <button type="submit" disabled={busy}>Search</button>
          </form>
          {found && (
            <div className="chips">
              {found.filter((n) => !c.allowed.includes(n)).map((n) => (
                <button key={n} type="button" className="chip" disabled={busy} onClick={() => allow([...c.allowed, n])} title="Allow the assistant to use this item">
                  + {n}
                </button>
              ))}
              {!found.length && <span className="muted small">No items match.</span>}
            </div>
          )}
        </div>
      )}
      {c.linked && (
        <div>
          <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm(`Unlink ${PM_NAMES[c.provider ?? "keepass"]}? The assistant stops being able to use its items.${c.provider === "keepass" ? " The vault file and its master password stay on the hub." : ""}`) && void run(async () => { await client!.unlinkPasswordManager(); return "Unlinked."; })}>
            Unlink {PM_NAMES[c.provider ?? "keepass"]}
          </button>
        </div>
      )}
      <Status msg={msg} />
    </section>
  );
}

export function ConnectionsPage() {
  const { on } = useModules();
  const [c, reload, loadErr] = useConnections();
  return (
    <SubPage path="/settings/connections">
      {!engine.client && <div className="empty">Set up the hub connection first.</div>}
      {engine.client && !c && !loadErr && <div className="muted">Loading</div>}
      {engine.client && !c && loadErr && <div className="error">{loadErr} <button type="button" className="small" onClick={reload}>Try again</button></div>}
      {c && (
        <>
          {on("mail") && c.google && <Gmail c={c.google} reload={reload} />}
          {(on("mail") || on("mail_inbox")) && c.icloud && <ICloudMail c={c.icloud} receipts={on("mail")} chat={on("mail_inbox")} reading={!!c.google?.reading} reload={reload} />}
          {on("mail_inbox") && c.imap && <OtherMail c={c.imap} reload={reload} />}
          {on("games") && <Steam c={c.steam} reload={reload} />}
          {on("films") && <Letterboxd c={c.letterboxd} reload={reload} />}
          {on("wiki") && c.atlassian && <Confluence c={c.atlassian} reload={reload} />}
          {on("homelab") && c.password_manager && <PasswordManager c={c.password_manager} reload={reload} />}
          {on("calendars") && <ICloudCalendar mailAccounts={(c.icloud?.accounts ?? []).map((a) => a.email)} />}
          {on("health") && <Health c={c.health} />}
          <CalendarFeed />
        </>
      )}
    </SubPage>
  );
}
