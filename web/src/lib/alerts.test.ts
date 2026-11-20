import { describe, expect, it } from "vitest";
import { alertOn, shownAlerts } from "./alerts";
import type { AlertInfo } from "../sync/api";

const LIST: AlertInfo[] = [
  { id: "reminder", title: "Reminders", summary: "", module: "notifications", on: true },
  { id: "mail", title: "New mail", summary: "", module: "mail_inbox", on: false },
  { id: "disk", title: "Hub disk space", summary: "", on: true },
];

describe("alert switches", () => {
  it("a kind is on unless the list says off; an unknown kind and an older hub's missing list are on", () => {
    expect(alertOn(LIST, "reminder")).toBe(true);
    expect(alertOn(LIST, "mail")).toBe(false);
    expect(alertOn(LIST, "something-new")).toBe(true);
    expect(alertOn(null, "mail")).toBe(true);
  });

  it("the settings page lists a kind only while its module is on; a kind of no module always shows", () => {
    const on = (id: string | undefined) => id !== "mail_inbox";
    expect(shownAlerts(LIST, on).map((a) => a.id)).toEqual(["reminder", "disk"]);
    expect(shownAlerts(LIST, () => true).map((a) => a.id)).toEqual(["reminder", "mail", "disk"]);
    expect(shownAlerts(null, () => true)).toEqual([]);
  });
});
