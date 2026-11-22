import { describe, expect, it } from "vitest";
import { allAppThemes, appThemeName, classicColors, contrast, resolveAppTheme, themeVars } from "./appTheme";
import { APP_THEMES, DEFAULT_FEEL } from "./prefs";
import { CLASSIC, MAIL_HOVER, MAIL_WORDS, mix, readable, type ThemeColors } from "./appTheme";
import { eventColorStyle } from "../lib/eventColor";

describe("app themes", () => {
  it("leaves Classic alone", () => {
    expect(resolveAppTheme(DEFAULT_FEEL)).toBeNull();
    expect(appThemeName(DEFAULT_FEEL)).toBe("Classic");
    expect(appThemeName({ ...DEFAULT_FEEL, appearance: "dark" })).toBe("Classic, dark");
    expect(classicColors("system", true).background).toBe("#17181b");
    expect(classicColors("light", true).background).toBe("#f5f4f1");
  });

  it("matches the hub's built-in colors", () => {
    expect(APP_THEMES.find((a) => a.id === "midnight")).toEqual({ id: "midnight", name: "Midnight", mode: "dark", accent: "#7C5CFF", background: "#0E1020", surface: "#181B33", text: "#E8E9F3" });
    expect(APP_THEMES.map((a) => a.id)).toEqual(["midnight", "paper", "daylight", "forest", "ocean", "sunset", "neon"]);
  });

  it("finds built-in and saved themes", () => {
    const cave = { id: "cave", name: "Cave", mode: "dark" as const, accent: "#33CCAA", background: "#101010", surface: "#1A1A1A", text: "#EEEEEE" };
    const f = { ...DEFAULT_FEEL, app_themes: [cave], app_theme: "custom:cave" };
    expect(resolveAppTheme(f)?.name).toBe("Cave");
    expect(resolveAppTheme({ ...f, app_theme: "paper" })?.mode).toBe("light");
    expect(allAppThemes(f).map((a) => a.id).slice(-1)).toEqual(["custom:cave"]);
  });

  for (const t of APP_THEMES) {
    it(`${t.name}: derived colors stay readable`, () => {
      const v = themeVars(t);
      expect(contrast(v["--text"], v["--bg"])).toBeGreaterThanOrEqual(7);
      for (const k of ["--muted", "--text-2"]) {
        expect(contrast(v[k], v["--bg"])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(v[k], v["--surface"])).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(v["--accent-text"], v["--accent"])).toBeGreaterThanOrEqual(4.5);
      expect(v["color-scheme"]).toBe(t.mode);
    });
  }

  it("keeps muted text readable even when the chosen colors are close", () => {
    const v = themeVars({ mode: "dark", accent: "#808080", background: "#202020", surface: "#303030", text: "#B0B0B0" });
    expect(contrast(v["--muted"], v["--surface"])).toBeGreaterThanOrEqual(Math.min(4.5, contrast("#B0B0B0", "#303030")));
  });
});

describe("status colors", () => {
  it("read as words at 4.5:1 on every built-in theme's background and cards, and on classic", () => {
    const themes: ThemeColors[] = [
      ...APP_THEMES,
      { mode: "light", accent: CLASSIC.light.accent, background: CLASSIC.light.bg, surface: CLASSIC.light.surface, text: CLASSIC.light.text },
      { mode: "dark", accent: CLASSIC.dark.accent, background: CLASSIC.dark.bg, surface: CLASSIC.dark.surface, text: CLASSIC.dark.text },
    ];
    for (const t of themes) {
      const v = themeVars(t);
      for (const k of ["--ok-text", "--warn-text", "--danger-text", "--link", "--muted", "--text-2"]) {
        for (const bg of [t.background, t.surface, v["--surface-2"]]) expect(contrast(v[k], bg), `${k} on ${t.mode} ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("use a theme's own status colors, made readable as words, and keep the fill as chosen", () => {
    const v = themeVars({ mode: "light", accent: "#0A84FF", background: "#FFFFFF", surface: "#FFFFFF", text: "#111111", warn: "#FFD60A" });
    expect(v["--warn"]).toBe("#FFD60A");
    expect(contrast(v["--warn-text"], "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(readable("#2b7047", "#111111", 4.5, ["#ffffff"])).toBe("#2b7047");
  });
});

describe("the Mail screen in a theme", () => {
  const pointedAt = (t: ThemeColors) => mix(t.surface, MAIL_HOVER[t.mode].veil, MAIL_HOVER[t.mode].part);

  it("sits on the theme's page and cards", () => {
    for (const t of APP_THEMES) {
      const v = themeVars(t);
      expect(v["--mail-page"]).toBe(t.background);
      expect(v["--mail-item"]).toBe(t.surface);
    }
  });

  it("keeps every kind of words readable on a mail's row while it is pointed at", () => {
    for (const t of APP_THEMES) {
      const v = themeVars(t);
      for (const k of ["--text", "--muted", "--text-2", "--link", "--ok-text", "--warn-text", "--danger-text"]) {
        for (const bg of [v["--mail-page"], v["--mail-item"], pointedAt(t)]) expect(contrast(v[k], bg), `${t.name}: ${k} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("writes Mail's colors as words that read on the page, a row and a pointed-at row, and as icons on the side list", () => {
    for (const t of APP_THEMES) {
      const v = themeVars(t);
      for (const id of Object.keys(MAIL_WORDS[t.mode])) {
        for (const bg of [t.background, t.surface, pointedAt(t)]) expect(contrast(v[`--bt-${id}`], bg), `${t.name}: ${id} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        // An icon, not words: 3:1 (the side list, and its current row on the second card color).
        expect(contrast(v[`--bt-${id}`], v["--surface-2"]), `${t.name}: ${id} icon`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("moves them toward the text color in a theme whose cards are too near them, and no further than it must", () => {
    const dusk: ThemeColors = { mode: "dark", accent: "#FFB000", background: "#3A3F4A", surface: "#4A505C", text: "#FFFFFF" };
    const v = themeVars(dusk);
    for (const id of Object.keys(MAIL_WORDS.dark)) {
      for (const bg of [dusk.background, dusk.surface, pointedAt(dusk)]) expect(contrast(v[`--bt-${id}`], bg), `${id} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(v["--bt-transactions"]).not.toBe(MAIL_WORDS.dark.transactions);
    // Midnight's page and cards are darker than Classic's: its colors stay as they are.
    const midnight = themeVars(APP_THEMES.find((a) => a.id === "midnight")!);
    expect(midnight["--bt-transactions"]).toBe(MAIL_WORDS.dark.transactions);
  });
});

describe("event colors", () => {
  it("come from the owner's choice, else the calendar's own color, else none (the accent)", () => {
    const cals = [{ key: "apple:iCloud/Home", name: "Home", color: "#1BADF8" }, { key: "icloud:https://x/gym/", name: "Gym", color: "#FF2968", chosen: "#00AA55" }];
    expect(eventColorStyle({ calendar_key: "apple:iCloud/Home" }, cals)).toEqual({ "--cal": "#1BADF8" });
    expect(eventColorStyle({ caldav: { account: "a", calendar: "https://x/gym/", uid: "u" } }, cals)).toEqual({ "--cal": "#00AA55" });
    expect(eventColorStyle({ title: "made here" }, cals)).toBeUndefined();
  });
});
