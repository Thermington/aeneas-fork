import { useState } from "react";
import type { Helper } from "../sync/api";
import { engine } from "../sync/engine";
import { useHelpers } from "../lib/helpersView";
import { wakeHelperAgent } from "../lib/helperAgent";
import { errorText } from "../views/settings/common";

/**
 * The one question a helped person is asked (docs/helpers.md): someone in their family offered to help with their
 * devices. Large and plain, two answers. After yes they are never asked again; Settings, People who help you, shows
 * what the helper did and has Stop.
 */
export function HelperOfferCard({ helper, onDone }: { helper: Helper; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const answer = async (yes: boolean) => {
    setBusy(true);
    setMsg("");
    try {
      if (yes) {
        await engine.client!.acceptHelper(helper.id);
        // On a Windows computer: its agent asks the hub at once, and turns on Start on login for helping.
        wakeHelperAgent();
      } else await engine.client!.stopHelper(helper.id);
      onDone?.();
    } catch (e) { setMsg(errorText(e)); } finally { setBusy(false); }
  };
  const n = helper.name;
  return (
    <div className="card col simple" role="region" aria-label={`${n} offered to help`}>
      <h2>{n} offered to help with your computer and phone</h2>
      <p>If you say yes, {n} can check your computer and fix problems on it, without asking you each time. {n} can also use the passwords you choose to save for {n}.</p>
      <p>This does not open your notes, chats or diary.</p>
      <p className="muted">You can stop it any time in Settings, People who help you.</p>
      <div className="choices">
        <button type="button" className="primary" disabled={busy} onClick={() => void answer(true)}>Yes, let {n} help</button>
        <button type="button" disabled={busy} onClick={() => void answer(false)}>No, thank you</button>
      </div>
      {msg && <div className="error">{msg}</div>}
    </div>
  );
}

/** At the top of the app while an offer waits for an answer (not on People who help you, which shows it itself). */
export function HelperOfferBanner({ path }: { path: string }) {
  const { view, refresh } = useHelpers();
  const offer = view?.helpers.find((h) => h.state === "offered");
  if (!offer || path.startsWith("/settings/helpers")) return null;
  return <HelperOfferCard helper={offer} onDone={() => void refresh()} />;
}
