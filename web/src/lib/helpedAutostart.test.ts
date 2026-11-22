import { describe, expect, it } from "vitest";
import { helpedAutostartDue, helpedAutostartLine, turnOnForHelping, type AutostartDeps } from "./helpedAutostart";

function fake(start: { enabled: boolean; done: boolean; fails?: boolean }) {
  const st = { ...start, enables: 0 };
  const deps: AutostartDeps = {
    isEnabled: async () => st.enabled,
    enable: async () => { if (st.fails) throw new Error("the registry said no"); st.enables++; st.enabled = true; },
    done: () => st.done,
    markDone: () => { st.done = true; },
  };
  return { st, deps };
}

describe("a helped person's Windows app starts at sign-in", () => {
  it("is due only while someone helps, on a computer switched on for it, and only once", () => {
    expect(helpedAutostartDue({ helping: true, computerOn: true, done: false })).toBe(true);
    expect(helpedAutostartDue({ helping: false, computerOn: true, done: false })).toBe(false);
    expect(helpedAutostartDue({ helping: true, computerOn: false, done: false })).toBe(false);
    expect(helpedAutostartDue({ helping: true, computerOn: true, done: true })).toBe(false);
  });

  it("turns it on the first time this computer is helped, and marks it done", async () => {
    const { st, deps } = fake({ enabled: false, done: false });
    expect(await turnOnForHelping({ helping: true, computerOn: true }, deps)).toBe("turned_on");
    expect(st).toMatchObject({ enabled: true, done: true, enables: 1 });
    // The next rounds change nothing.
    expect(await turnOnForHelping({ helping: true, computerOn: true }, deps)).toBe("not_due");
    expect(st.enables).toBe(1);
  });

  it("does nothing for a computer nobody helps (every other user of the Windows app)", async () => {
    const { st, deps } = fake({ enabled: false, done: false });
    expect(await turnOnForHelping({ helping: false, computerOn: true }, deps)).toBe("not_due");
    expect(st).toMatchObject({ enabled: false, done: false, enables: 0 });
  });

  it("does nothing on a computer the person switched off for their helper", async () => {
    const { st, deps } = fake({ enabled: false, done: false });
    expect(await turnOnForHelping({ helping: true, computerOn: false }, deps)).toBe("not_due");
    expect(st.enabled).toBe(false);
  });

  it("keeps the person's Off: once done, never turned on again, even when helped again after Stop", async () => {
    const { st, deps } = fake({ enabled: false, done: true });
    expect(await turnOnForHelping({ helping: true, computerOn: true }, deps)).toBe("not_due");
    expect(st).toMatchObject({ enabled: false, enables: 0 });
  });

  it("already on: left alone and marked done, so turning it off later sticks", async () => {
    const { st, deps } = fake({ enabled: true, done: false });
    expect(await turnOnForHelping({ helping: true, computerOn: true }, deps)).toBe("already_on");
    expect(st).toMatchObject({ enabled: true, done: true, enables: 0 });
  });

  it("a failure marks nothing, so the next round tries again", async () => {
    const { st, deps } = fake({ enabled: false, done: false, fails: true });
    await expect(turnOnForHelping({ helping: true, computerOn: true }, deps)).rejects.toThrow("the registry said no");
    expect(st.done).toBe(false);
    st.fails = false;
    expect(await turnOnForHelping({ helping: true, computerOn: true }, deps)).toBe("turned_on");
  });

  it("says in one plain line what changed and where to turn it off", () => {
    const line = helpedAutostartLine("Robin");
    expect(line).toBe("Aeneas now starts when you sign in to Windows, so Robin can help after a restart. To turn that off: Settings, Windows, Start on login.");
    expect(line).not.toMatch(/[–—]/);
  });
});
