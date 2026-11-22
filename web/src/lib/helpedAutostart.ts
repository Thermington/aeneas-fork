/**
 * A helped person's Windows computer starts Aeneas when they sign in (docs/helpers.md), so their helper can help after
 * a restart without them doing anything. Turned on once: the first time this computer is in use for a helper (someone
 * helps them and the computer is not switched off for it). After that it is the person's own setting: turned off in
 * Settings, Windows, it stays off, and Stop leaves it as it is. Only the Windows app does this (lib/helperAgent.ts).
 */

/** Set once start at sign-in was turned on for helping (or was already on then). */
export const HELPED_AUTOSTART_PREF = "ea.helpedAutostart";

/** Whether to turn start at sign-in on now. */
export function helpedAutostartDue(s: { helping: boolean; computerOn: boolean; done: boolean }): boolean {
  return s.helping && s.computerOn && !s.done;
}

export interface AutostartDeps {
  isEnabled: () => Promise<boolean>;
  enable: () => Promise<void>;
  /** Whether it was turned on for helping before (HELPED_AUTOSTART_PREF). */
  done: () => boolean;
  markDone: () => void;
}

/**
 * Turns start at sign-in on for helping when it is due. "turned_on" when it did, "already_on" when it was on (marked
 * done all the same, so a later Off by the person is kept), "not_due" otherwise. A failure is thrown and nothing is
 * marked, so it is tried again on the next round.
 */
export async function turnOnForHelping(s: { helping: boolean; computerOn: boolean }, d: AutostartDeps): Promise<"turned_on" | "already_on" | "not_due"> {
  if (!helpedAutostartDue({ ...s, done: d.done() })) return "not_due";
  if (await d.isEnabled()) { d.markDone(); return "already_on"; }
  await d.enable();
  d.markDone();
  return "turned_on";
}

/** The one line the helped person reads (People who help you, This computer), while it is on. */
export function helpedAutostartLine(who: string): string {
  return `Aeneas now starts when you sign in to Windows, so ${who} can help after a restart. To turn that off: Settings, Windows, Start on login.`;
}
