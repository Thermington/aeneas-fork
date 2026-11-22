import { useEffect, useState } from "react";
import type { Helper, HelpersView } from "../../sync/api";
import { engine } from "../../sync/engine";
import { inSentence, sinceText, useHelpers, whenText } from "../../lib/helpersView";
import { canBeHelperComputer, helpedAutostartDone, helperComputerOn, onHelpedAutostart, setHelperComputer } from "../../lib/helperAgent";
import { helpedAutostartLine } from "../../lib/helpedAutostart";
import { autostartEnabled, isTauri, scanHomeNetwork } from "../../tauri/bridge";
import { HelperOfferCard } from "../../components/HelperOffer";
import { SubPage, errorText } from "./common";

/**
 * Settings, People who help you (docs/helpers.md): for someone helped by a family member they trust fully. Large and
 * plain, one thing per card: who helps them and Stop, this computer, the devices in their home, the passwords they
 * saved for their helper, and everything the helper did.
 */

/** The Settings row's summary, or null to leave the row out (nobody helps or offered). */
export function useHelpersSummary(): string | null {
  const { view } = useHelpers();
  const active = view?.helpers.filter((h) => h.state === "active") ?? [];
  const offered = view?.helpers.filter((h) => h.state === "offered") ?? [];
  if (active.length) return `${names(active)} ${active.length > 1 ? "help" : "helps"} you`;
  if (offered.length) return `${names(offered)} offered to help`;
  return null;
}
const names = (list: Helper[]) => list.map((h) => h.name).join(" and ");

export function HelpersPage() {
  const { view, refresh } = useHelpers();
  const active = view?.helpers.filter((h) => h.state === "active") ?? [];
  const offered = view?.helpers.filter((h) => h.state === "offered") ?? [];
  const who = active.length ? names(active) : "your helper";
  return (
    <SubPage path="/settings/helpers">
      <div className="col simple" style={{ gap: 16 }}>
        {!view && <p className="muted">Asking your hub.</p>}
        {view && !active.length && !offered.length && (
          <div className="card col">
            <h2>{view.helpers.some((h) => h.state === "stopped") ? "Nobody helps you now" : "Nobody helps you yet"}</h2>
            <p>When someone in your family offers to help with your computer and phone, you can say yes here.</p>
          </div>
        )}
        {offered.map((h) => <HelperOfferCard key={h.id} helper={h} onDone={() => void refresh()} />)}
        {active.map((h) => <HelperCard key={h.id} helper={h} onDone={() => void refresh()} />)}
        {!!active.length && canBeHelperComputer && <ThisComputer who={who} view={view!} onDone={() => void refresh()} />}
        {!!active.length && (isTauri || !!view?.scan) && <HomeDevices who={who} view={view!} onDone={() => void refresh()} />}
        {!!active.length && <Passwords who={who} view={view!} onDone={() => void refresh()} />}
        {view && view.log.length > 0 && <Log view={view} />}
      </div>
    </SubPage>
  );
}

function HelperCard({ helper, onDone }: { helper: Helper; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const n = helper.name;
  const stop = async () => {
    if (!window.confirm(`Stop ${n}'s help? ${n} will not be able to check or fix your devices until you say yes again.`)) return;
    setBusy(true);
    try { await engine.client!.stopHelper(helper.id); onDone(); } catch (e) { setMsg(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card col">
      <div className="big-ok">{n} helps you</div>
      <p>{n} can check your computer and fix problems without asking you. Everything {n} does is listed at the bottom of this page.</p>
      {helper.accepted_at && <p className="when">{sinceText(helper.accepted_at)}</p>}
      <div className="choices">
        <button type="button" className="danger" disabled={busy} onClick={() => void stop()}>Stop {n}&rsquo;s help</button>
      </div>
      {msg && <div className="error">{msg}</div>}
    </div>
  );
}

function ThisComputer({ who, view, onDone }: { who: string; view: HelpersView; onDone: () => void }) {
  const [on, setOn] = useState(helperComputerOn());
  // Start on login, turned on for helping (lib/helpedAutostart.ts): said here while it is on.
  const [startsAtSignIn, setStartsAtSignIn] = useState(false);
  useEffect(() => {
    const look = () => { if (helpedAutostartDone()) void autostartEnabled().then(setStartsAtSignIn).catch(() => setStartsAtSignIn(false)); };
    look();
    return onHelpedAutostart(look);
  }, []);
  const listening = view.this_device?.agent?.listening ?? false;
  const set = async (next: boolean) => {
    setOn(next);
    await setHelperComputer(next);
    onDone();
  };
  return (
    <div className="card col">
      <h2>This computer</h2>
      {on
        ? <p>{who} can check and fix this computer while Aeneas is open on it. {listening ? "It is ready now." : "It gets ready in a moment."}</p>
        : <p>{who} cannot use this computer now.</p>}
      {on && startsAtSignIn && <p className="muted">{helpedAutostartLine(who)}</p>}
      <div className="choices">
        {on
          ? <button type="button" onClick={() => void set(false)}>Do not let {who} use this computer</button>
          : <button type="button" className="primary" onClick={() => void set(true)}>Let {who} use this computer</button>}
      </div>
    </div>
  );
}

function HomeDevices({ who, view, onDone }: { who: string; view: HelpersView; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const scan = view.scan;
  const look = async () => {
    setBusy(true);
    setMsg("");
    try {
      const found = await scanHomeNetwork();
      await engine.client!.sendHomeScan({ network: found.network, devices: found.devices });
      onDone();
    } catch (e) { setMsg(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card col">
      <h2>The devices in your home</h2>
      {isTauri ? (
        <>
          <p>This looks for the computers, printers, phones and other devices on your home Wi-Fi, so {who} knows what is there. It takes about 20 seconds.</p>
          <div className="choices">
            <button type="button" className="primary" disabled={busy} onClick={() => void look()}>{busy ? "Looking, about 20 seconds" : "Find the devices in my home"}</button>
          </div>
        </>
      ) : <p>Your phone or computer with the Aeneas app looked for the devices on your home Wi-Fi.</p>}
      {msg && <div className="error">{msg}</div>}
      {scan && !busy && (
        <>
          <p className="big-ok">Found {scan.devices.length} {scan.devices.length === 1 ? "device" : "devices"}. {who} can see this list.</p>
          <p className="when">Looked {inSentence(scan.at)}</p>
          <div className="col">
            {scan.devices.map((d) => (
              <div key={d.ip} className="log-line">
                {d.name ? <strong>{d.name}</strong> : null}{d.name ? ", " : ""}{d.kind ?? "device"} <span className="muted">({d.ip})</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Passwords({ who, view, onDone }: { who: string; view: HelpersView; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [device, setDevice] = useState("");
  const devices = (view.scan?.devices ?? []).filter((d) => d.name !== "This computer");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await engine.client!.saveHelperPassword({ title: title.trim(), username: username.trim() || undefined, password, ...(device ? { device } : {}) });
      setMsg({ ok: true, text: `Saved. ${who} can use "${title.trim()}" now.` });
      setTitle(""); setUsername(""); setPassword(""); setDevice("");
      onDone();
    } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  const remove = async (t: string) => {
    if (!window.confirm(`Remove the password "${t}"? ${who} will not be able to use it any more.`)) return;
    try { await engine.client!.removeHelperPassword(t); onDone(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
  };
  return (
    <div className="card col">
      <h2>Passwords for {who}</h2>
      <p>Save a password here only if you want {who} to use it, like the password for this computer or for your email. It is kept on your hub, and it is never shown in a chat.</p>
      {view.passwords.length > 0 && (
        <div className="col">
          {view.passwords.map((p) => (
            <div key={p.title} className="log-line row" style={{ alignItems: "center" }}>
              <div className="grow"><strong>{p.title}</strong>{p.username ? <span className="muted">, user name {p.username}</span> : null}{p.device ? <span className="muted">, for the device at {p.device}</span> : null}</div>
              <button type="button" onClick={() => void remove(p.title)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <form className="col" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="col">What is it for?
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="My computer" maxLength={80} autoComplete="off" />
        </label>
        <label className="col">User name, if it has one
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </label>
        <label className="col">Password
          <input type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoCapitalize="off" spellCheck={false} />
        </label>
        {devices.length > 0 && (
          <label className="col">Is it for one of the devices in your home? You can skip this.
            <select value={device} onChange={(e) => setDevice(e.target.value)}>
              <option value="">No, or I am not sure</option>
              {devices.map((d) => <option key={d.ip} value={d.ip}>{d.name ? `${d.name}, ` : ""}{d.kind ?? "device"} ({d.ip})</option>)}
            </select>
          </label>
        )}
        <label className="row" style={{ alignItems: "center", gap: 10 }}>
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} style={{ width: 24, height: 24, minHeight: 24 }} /> Show the password as I type
        </label>
        <div className="choices">
          <button type="submit" className="primary" disabled={busy || !title.trim() || !password}>Save password</button>
        </div>
      </form>
      {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
    </div>
  );
}

function Log({ view }: { view: HelpersView }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="card col">
      <h2>What happened</h2>
      <div className="col">
        {view.log.map((l) => (
          <div key={l.id} className="log-line col" style={{ gap: 2 }}>
            <span className="when">{whenText(l.at)}{l.device ? `, on ${l.device}` : ""}</span>
            <span>{l.kind === "check" || l.kind === "change" ? `${l.helper}: ${l.text}` : l.text}</span>
            {l.detail && (open === l.id
              ? <pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}><code>{l.detail}</code></pre>
              : <button type="button" className="ghost small" style={{ alignSelf: "flex-start", minHeight: 36, fontSize: 16 }} onClick={() => setOpen(l.id)}>Show exactly what was run</button>)}
          </div>
        ))}
      </div>
    </div>
  );
}
