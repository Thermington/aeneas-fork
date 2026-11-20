import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAIL_HOVER, MAIL_WORDS } from "../feel/appTheme";

/** WCAG relative luminance from a #rrggbb string. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

export function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Pulls `--name: #hex;` tokens out of one CSS block. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const light = tokens(css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)")));
const darkStart = css.indexOf(':root[data-theme="dark"]');
const dark = tokens(css.slice(darkStart, css.indexOf("}", darkStart)));
/** The same dark tokens again, for a system in dark mode with no appearance chosen. */
const systemDarkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const systemDark = tokens(css.slice(systemDarkStart, css.indexOf("}", systemDarkStart)));

/** `top` laid over `bottom` with `part` of it showing (0 to 1), as a #rrggbb. */
function over(top: string, part: number, bottom: string): string {
  const a = parseInt(top.slice(1), 16);
  const b = parseInt(bottom.slice(1), 16);
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * part + ((b >> shift) & 255) * (1 - part));
  return "#" + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, "0")).join("");
}

/** A black or white veil written as `rgb(0 0 0 / .2)` in the rule that starts with `selector`: its color and how much of it shows. */
function veil(selector: string): { color: string; part: number } {
  const at = css.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const m = /rgb\((0 0 0|255 255 255) \/ (\.\d+)\)/.exec(css.slice(at, css.indexOf("}", at)));
  expect(m, selector).not.toBeNull();
  return { color: m![1] === "0 0 0" ? "#000000" : "#ffffff", part: Number(m![2]) };
}

const MAIL = Object.keys(MAIL_WORDS.light);

describe("design token contrast", () => {
  for (const [name, t] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`${name}: status text (text-2) reads at 4.5:1 on bg and surface`, () => {
      expect(contrast(t["text-2"], t.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["text-2"], t.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: body text and muted text read on bg and surface`, () => {
      expect(contrast(t.text, t.bg)).toBeGreaterThanOrEqual(7);
      expect(contrast(t.muted, t.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: primary button text reads on the accent`, () => {
      expect(contrast(t["accent-text"], t.accent)).toBeGreaterThanOrEqual(4.5);
    });

    // The Mail screen (Mail.tsx). Its fills carry white; its words sit on the page, a mail's row, a row being pointed at
    // (the row under a thin veil) and the side list.
    const pointedAt = over(MAIL_HOVER[name].veil, MAIL_HOVER[name].part, t["mail-item"]);
    it(`${name}: Mail's colors carry white (the bar's words, a bundle's icon, a sender's initials)`, () => {
      for (const id of MAIL) expect(contrast("#ffffff", t[`b-${id}`]), `white on ${id}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: Mail's colors as words read on the page, a row and a row being pointed at, and as icons on the side list`, () => {
      for (const id of MAIL) {
        expect(t[`bt-${id}`], id).toBe(MAIL_WORDS[name][id as keyof typeof MAIL_WORDS.light]);
        for (const bg of [t["mail-page"], t["mail-item"], pointedAt]) expect(contrast(t[`bt-${id}`], bg), `${id} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        for (const bg of [t.surface, t["surface-2"]]) expect(contrast(t[`bt-${id}`], bg), `${id} icon on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${name}: every kind of words reads on Mail's page, a row and a row being pointed at`, () => {
      for (const k of ["text", "muted", "text-2", "link", "danger-text", "ok-text", "warn-text"]) {
        for (const bg of [t["mail-page"], t["mail-item"], pointedAt]) expect(contrast(t[k], bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: Mail's search box carries white words and its placeholder on every bar color`, () => {
      const box = veil(".mailx-search {");
      const placeholder = veil(".mailx-search::placeholder {");
      expect(box.color).toBe("#000000");
      expect(placeholder.color).toBe("#ffffff");
      // Every button on the bar that has a shade of its own (New mail, Refresh and the selection's buttons when pointed
      // at): the bar darkened, as the search box, so their white words read too.
      for (const rule of [".mailx-compose-btn {", ".mailx-compose-btn:hover {", ".mailx-refresh:hover {", ".mailx-selbar button:hover {"]) expect(veil(rule).color, rule).toBe("#000000");
      for (const id of MAIL) {
        const field = over(box.color, box.part, t[`b-${id}`]);
        expect(contrast("#ffffff", field), `typed words on ${id}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(over(placeholder.color, placeholder.part, field), field), `placeholder on ${id}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("the veil over a pointed-at mail is the one the themes count on", () => {
    const lightVeil = /--mail-hover: rgb\(0 0 0 \/ (\.\d+)\);/.exec(css.slice(0, systemDarkStart));
    const darkVeil = /--mail-hover: rgb\(255 255 255 \/ (\.\d+)\);/.exec(css.slice(darkStart));
    expect(Number(lightVeil?.[1])).toBe(MAIL_HOVER.light.part);
    expect(Number(darkVeil?.[1])).toBe(MAIL_HOVER.dark.part);
  });

  it("dark is the same whether the system or the appearance setting chose it", () => {
    expect(systemDark).toEqual(dark);
    for (const rule of ["--mail-hover"]) {
      const a = new RegExp(`${rule}: ([^;]+);`).exec(css.slice(systemDarkStart, css.indexOf("}", systemDarkStart)));
      const b = new RegExp(`${rule}: ([^;]+);`).exec(css.slice(darkStart, css.indexOf("}", darkStart)));
      expect(a?.[1]).toBe(b?.[1]);
      expect(a).not.toBeNull();
    }
  });
});
