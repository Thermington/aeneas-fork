import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BUNDLES, needsYou, whereLabel, fileSize, previewSrc, riskyFile, MAIL_KEYS, folderCount, folderLabel, folderWho, type FolderMail, type MailFolder, tripDates, tripsOf, type MailCard, swipeAction, swipeLock, cardLine, cardLink, cardTime, bundleClass, bundleOf, dueReminders, mailKeyAction, deliveryAt, inboxAt, QUOTE_SELECTOR, threadRows, frameLink, initials, logoSrc, shownAt, snoozeChoices, httpsLink, dayGroup, inboxSections, initial, matches, messageLines, nameHidesAddress, replyToWarning, sendersLine, shownBundles, textParts, viewMessages, whenLabel, type MailSummary } from "./mail";
import { SCREEN_MODULE, moduleOfScreen } from "./modules";

const ALEX = { name: "Alex", address: "alex@example.com" };
const NOW = new Date(2026, 10, 19, 15, 0);
const at = (daysAgo: number, h = 9) => new Date(2026, 10, 19 - daysAgo, h).toISOString();
let n = 0;
const mail = (over: Partial<MailSummary> = {}): MailSummary => ({ id: `m${++n}`, at: at(0), from: ALEX, subject: `Mail ${n}`, preview: "Hello", automated: false, bundle: null, state: "inbox", pinned: false, ...over });
const allOn = () => true;

describe("mail screen rules", () => {
  it("groups by day: Today, Yesterday, This week, This month, then months", () => {
    expect(dayGroup(at(0, 8), NOW)).toBe("Today");
    expect(dayGroup(at(1, 23), NOW)).toBe("Yesterday");
    expect(dayGroup(at(5), NOW)).toBe("This week");
    expect(dayGroup(at(12), NOW)).toBe("This month");
    expect(dayGroup(new Date(2026, 9, 3).toISOString(), NOW)).toBe(new Date(2026, 9, 3).toLocaleDateString([], { month: "long", year: "numeric" }));
    expect(dayGroup("nonsense", NOW)).toBe("Earlier");
    expect(whenLabel(at(0, 9), NOW)).toBe(new Date(2026, 10, 19, 9).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    expect(whenLabel(at(3), NOW)).toBe(new Date(2026, 10, 16, 9).toLocaleDateString([], { weekday: "short" }));
  });

  it("shows module bundles only while their module is on; other mail in an unknown or hidden bundle stands alone", () => {
    const off = (id: string) => id !== "pet";
    expect(shownBundles(allOn).map((b) => b.id)).toEqual(BUNDLES.map((b) => b.id));
    expect(shownBundles(off).map((b) => b.id)).not.toContain("pet");
    expect(shownBundles(off).map((b) => b.id)).toContain("promos");
    expect(bundleOf({ bundle: "pet" }, shownBundles(off))).toBeNull();
    expect(bundleOf({ bundle: "made-up" }, shownBundles(allOn))).toBeNull();
    expect(bundleOf({ bundle: "promos" }, shownBundles(allOn))?.name).toBe("Promos");
  });

  it("lists the Inbox newest first under day headings, a bundle as one row per day, pinned mail on its own", () => {
    const shown = shownBundles(allOn);
    const ms = [
      mail({ at: at(0, 10), subject: "Hike?" }),
      mail({ at: at(0, 9), bundle: "purchases", from: { name: "Northwind", address: "o@northwind.example" } }),
      mail({ at: at(0, 8), bundle: "purchases", from: { name: "Larkspur Books", address: "r@larkspur.example" } }),
      mail({ at: at(0, 7), bundle: "purchases", pinned: true, subject: "Pinned receipt" }),
      mail({ at: at(1), bundle: "purchases" }),
      mail({ at: at(0, 6), state: "done", subject: "Done one" }),
      mail({ at: at(0, 5), state: "snoozed", subject: "Snoozed one" }),
    ];
    const s = inboxSections(ms, shown, { now: NOW });
    expect(s.map((x) => x.title)).toEqual(["Today", "Yesterday"]);
    expect(s[0].rows.map((r) => (r.kind === "mail" ? r.mail.subject : `[${r.bundle.name} ${r.mails.length}]`))).toEqual(["Hike?", "[Purchases 2]", "Pinned receipt"]);
    const bundle = s[0].rows[1];
    expect(bundle.kind === "bundle" && sendersLine(bundle.mails)).toBe("Northwind, Larkspur Books");
    expect(s[1].rows.map((r) => r.kind)).toEqual(["bundle"]);
    expect(inboxSections(ms, shown, { now: NOW, pinnedOnly: true }).flatMap((x) => x.rows).map((r) => r.kind === "mail" && r.mail.subject)).toEqual(["Pinned receipt"]);
    expect(viewMessages(ms, "done", shown).map((m) => m.subject)).toEqual(["Done one"]);
    expect(viewMessages(ms, "snoozed", shown).map((m) => m.subject)).toEqual(["Snoozed one"]);
    expect(viewMessages(ms, "b:purchases", shown)).toHaveLength(4);
  });

  it("searches sender, subject and first words, every word", () => {
    const m = mail({ subject: "Gutters this weekend", preview: "Bring the ladder" });
    expect(matches(m, "")).toBe(true);
    expect(matches(m, "alex LADDER")).toBe(true);
    expect(matches(m, "alex roof")).toBe(false);
  });

  it("gives each sender a letter", () => {
    expect(initial(ALEX)).toBe("A");
    expect(initial({ name: "", address: "sam@example.com" })).toBe("S");
    expect(initial({ name: "\"Ölund\"", address: "x@y" })).toBe("Ö");
    expect(initial({ name: "", address: "" })).toBe("?");
    expect(initials({ name: "Alumni Relations Team", address: "a@x" })).toBe("AT");
    expect(initials({ name: "jordan avery", address: "j@x" })).toBe("JA");
    expect(initials(ALEX)).toBe("A");
    expect(initials({ name: "", address: "sam@example.com" })).toBe("S");
  });

  it("offers the snooze times: later today, tomorrow, the weekend, next week", () => {
    const thu = new Date(2026, 10, 19, 15, 0); // a Thursday, 3 PM
    expect(snoozeChoices(thu).map((c) => [c.id, c.label, c.at.getTime()])).toEqual([
      ["later", "Later today", new Date(2026, 10, 19, 18).getTime()],
      ["tomorrow", "Tomorrow", new Date(2026, 10, 20, 8).getTime()],
      ["weekend", "This weekend", new Date(2026, 10, 21, 9).getTime()],
      ["nextweek", "Next week", new Date(2026, 10, 23, 8).getTime()],
    ]);
    expect(snoozeChoices(new Date(2026, 10, 19, 19, 0)).map((c) => c.id)).not.toContain("later");
    const sat = snoozeChoices(new Date(2026, 10, 21, 10, 0));
    expect(sat.find((c) => c.id === "weekend")).toMatchObject({ label: "Next weekend", at: new Date(2026, 10, 28, 9) });
    expect(sat.find((c) => c.id === "nextweek")!.at).toEqual(new Date(2026, 10, 23, 8));
  });

  it("adds the owner's own bundles after the built-in ones, in their own colors", () => {
    const school = { id: "c-0123456789", name: "School", color: 2, addresses: [], domains: ["school.example"], words: [] };
    const shown = shownBundles(allOn, [school]);
    expect(shown.map((b) => b.id)).toEqual([...BUNDLES.map((b) => b.id), "c-0123456789"]);
    expect(bundleClass(shown[shown.length - 1])).toBe("b-custom cc2");
    expect(bundleClass(BUNDLES[0])).toBe("b-purchases");
    expect(bundleOf({ bundle: "c-0123456789" }, shown)?.name).toBe("School");
  });

  it("maps the Mail screen's keys: arrows to move, letters to act, nothing while typing but Escape", () => {
    const k = (key: string, more: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}, typing = false) =>
      mailKeyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...more }, typing);
    expect([k("ArrowDown"), k("ArrowUp"), k("ArrowDown", { shiftKey: true }), k("Enter"), k(" "), k("Escape")]).toEqual(["down", "up", "extend-down", "open", "select", "escape"]);
    expect([k("d"), k("D", { shiftKey: true }), k("s"), k("p"), k("u"), k("r"), k("/"), k("?")]).toEqual(["done", "done", "snooze", "pin", "unread", "read", "search", "help"]);
    expect(k("d", {}, true)).toBeNull();
    expect(k("Escape", {}, true)).toBe("escape");
    expect(k("p", { ctrlKey: true })).toBeNull();
    expect(k("r", { metaKey: true })).toBeNull();
    expect(k("t")).toBeNull();
  });

  it("shows the reminders that are due among the mail, never a mail's own snooze task", () => {
    const now = new Date(2026, 10, 20, 12);
    const iso = (h: number, d = 20) => new Date(2026, 10, d, h).toISOString();
    const t = (id: string, fields: Record<string, unknown>) => ({ id, fields: { title: id, status: "scheduled", ...fields } });
    const due = dueReminders([
      t("dentist", { remind_at: iso(9) }),
      t("overdue", { remind_at: iso(9, 18), friction: "reason" }),
      t("later", { remind_at: iso(15) }),
      t("snoozed", { remind_at: iso(8), snoozed_until: iso(14) }),
      t("woke", { remind_at: iso(7), snoozed_until: iso(11) }),
      t("finished", { remind_at: iso(9), status: "done" }),
      t("mailsnooze", { remind_at: iso(9), mail: "abc" }),
      t("notime", {}),
    ], now);
    expect(due.map((r) => r.id)).toEqual(["overdue", "dentist", "woke"]);
    expect(due[0].friction).toBe("reason");
    expect(due[2].at).toBe(iso(11));
  });

  it("folds the same quoted history the hub's page folds", () => {
    const hub = fs.readFileSync(path.join(__dirname, "../../../hub/src/mail-html.ts"), "utf8");
    expect(hub).toContain(`export const QUOTE_SELECTOR = '${QUOTE_SELECTOR}';`);
  });

  it("shows a thread as one row: its people, newest time, state, unread and the ids each action takes", () => {
    const g1 = mail({ thread: "t1", at: at(3), subject: "Gutters", seen: true, preview: "Saturday?" });
    const me = mail({ thread: "t1", at: at(2), subject: "Re: Gutters", mine: true, state: "sent", from: { name: "Robin", address: "robin@icloud.example" }, preview: "Yes, 10 AM." });
    const g2 = mail({ thread: "t1", at: at(1), subject: "Re: Gutters", seen: false, preview: "Bring the ladder." });
    const shop = mail({ thread: "t2", at: at(0, 8), automated: true, bundle: "purchases", from: { name: "Northwind", address: "o@northwind.example" } });
    const lonely = mail({ thread: "t3", mine: true, state: "sent" });
    const rows = threadRows([g1, me, g2, shop, lonely]);
    expect(rows).toHaveLength(2);
    const t = rows.find((r) => r.thread === "t1")!;
    expect([t.id, t.subject, t.people, t.state, t.seen, t.at]).toEqual([g2.id, "Gutters", "Alex, me (3)", "inbox", false, g2.at]);
    expect(t.members.map((m) => m.id)).toEqual([g1.id, me.id, g2.id]);
    expect(t.ids).toEqual({ open: [g1.id, g2.id], done: [], unread: [g2.id] });
    expect(t.bundle).toBeNull();
    expect(rows.find((r) => r.thread === "t2")!.people).toBe("Northwind");
    // Done with one message, the other still in the Inbox: the thread stays in the Inbox.
    expect(threadRows([{ ...g1, state: "done" }, g2])[0].state).toBe("inbox");
    expect(threadRows([{ ...g1, state: "done" }, { ...g2, state: "done" }])[0].ids.done).toEqual([g1.id, g2.id]);
    expect(threadRows([me, { ...g2, preview: "x" }, { ...me, id: "m-late", at: at(0, 9), preview: "See you" }])[0].preview).toBe("You: See you");
  });

  it("uses the owner's own snooze times", () => {
    const thu = new Date(2026, 10, 19, 15, 0); // a Thursday, 3 PM
    const mine = snoozeChoices(thu, { later_hours: 2, tomorrow: "07:30", weekend_day: 0, weekend_time: "10:15", week_day: 2, week_time: "09:00" });
    expect(mine.map((c) => c.at.getTime())).toEqual([
      new Date(2026, 10, 19, 17).getTime(),
      new Date(2026, 10, 20, 7, 30).getTime(),
      new Date(2026, 10, 22, 10, 15).getTime(), // Sunday
      new Date(2026, 10, 24, 9).getTime(), // Tuesday
    ]);
  });

  it("holds a bundle's mail until its time, or keeps it out of the Inbox; pinned mail always shows", () => {
    const iso = (d: Date) => d.toISOString();
    // Arrived Thursday 10:30 AM.
    const arrived = iso(new Date(2026, 10, 19, 10, 30));
    expect(deliveryAt(arrived, { mode: "daily", time: "07:00" })).toEqual(new Date(2026, 10, 20, 7));
    expect(deliveryAt(arrived, { mode: "daily", time: "18:00" })).toEqual(new Date(2026, 10, 19, 18));
    expect(deliveryAt(arrived, { mode: "weekly", day: 0, time: "18:00" })).toEqual(new Date(2026, 10, 22, 18));
    expect(deliveryAt(arrived, { mode: "weekly", day: 4, time: "09:00" })).toEqual(new Date(2026, 10, 26, 9)); // Thursday 9 AM had passed: next week's
    expect(deliveryAt(arrived, { mode: "never" })).toBeNull();
    expect(deliveryAt(arrived, undefined)).toEqual(new Date(arrived));

    const delivery = { promos: { mode: "daily" as const, time: "07:00" }, social: { mode: "never" as const } };
    const promo = mail({ at: arrived, bundle: "promos", automated: true });
    const pinned = mail({ at: arrived, bundle: "promos", automated: true, pinned: true });
    const social = mail({ at: arrived, bundle: "social", automated: true });
    const person = mail({ at: arrived });
    const thuNoon = new Date(2026, 10, 19, 12);
    expect(inboxAt(promo, delivery, thuNoon)).toBeNull();
    expect(inboxAt(promo, delivery, new Date(2026, 10, 20, 8))).toBe(iso(new Date(2026, 10, 20, 7))); // listed by when it showed
    expect(inboxAt(pinned, delivery, thuNoon)).toBe(arrived);
    expect(inboxAt(social, delivery, new Date(2027, 0, 1))).toBeNull();
    expect(inboxAt(person, delivery, thuNoon)).toBe(arrived);
    const rows = inboxSections([promo, pinned, social, person], shownBundles(allOn), { now: thuNoon, delivery }).flatMap((s) => s.rows);
    expect(rows.map((r) => (r.kind === "mail" ? r.mail.id : r.bundle.id))).toEqual([pinned.id, person.id]);
  });

  it("lists a mail back from a snooze by when it came back, at the top", () => {
    const old = mail({ at: at(5), subject: "Back from snooze", back_at: at(0, 14) });
    const fresh = mail({ at: at(0, 10), subject: "Fresh" });
    expect(shownAt(old)).toBe(at(0, 14));
    const s = inboxSections([fresh, old], shownBundles(allOn), { now: NOW });
    expect(s[0].title).toBe("Today");
    expect(s[0].rows.map((r) => r.kind === "mail" && r.mail.subject)).toEqual(["Back from snooze", "Fresh"]);
  });

  it("shows a logo only as the hub sends it: a data: SVG picture", () => {
    const svg = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}`;
    expect(logoSrc(svg)).toBe(svg);
    expect(logoSrc("https://cdn.shop.example/logo.svg")).toBeNull();
    expect(logoSrc("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(logoSrc(`${svg}" onerror="alert(1)`)).toBeNull();
    expect(logoSrc(undefined)).toBeNull();
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    // The verified logo, and an attachment's preview (previewSrc: a data: picture, checked): no other picture.
    expect(src.match(/<img [^>]*>/g)).toEqual([`<img src={logo} alt="" />`, `<img src={src} alt={a.name} />`]);
    expect(src).toMatch(/const src = previewSrc\(a\.preview\)/);
    expect(src).toMatch(/const logo = m\.logo_domain \? logoSrc\(logos\[m\.logo_domain\]\) : null;/);
  });

  it("shows a button line as a link to its https host, and only then", () => {
    const m = { text: "Out for delivery.\n\nTrack my shipment\nTrack at fedex.com\nPay now", links: [
      { text: "Track my shipment", url: "https://store.shop.example/orders/1?key=x" },
      { text: "Track at fedex.com", url: "https://evil.example/fedex" },
      { text: "Pay now", url: "http://shop.example/pay" },
      { text: "Not a line here", url: "https://shop.example/x" },
    ] };
    const lines = messageLines(m);
    expect(lines.map((l) => l.text)).toEqual(["Out for delivery.", "", "Track my shipment", "Track at fedex.com", "Pay now"]);
    expect(lines[2].link).toEqual({ href: "https://store.shop.example/orders/1?key=x", host: "store.shop.example" });
    expect(lines[3].link, "the label names another site").toBeUndefined();
    expect(lines[4].link, "not https").toBeUndefined();
    expect(messageLines({ text: "Track at fedex.com", links: [{ text: "Track at fedex.com", url: "https://www.fedex.com/t" }] })[0].link?.host).toBe("www.fedex.com");
    for (const bad of ["javascript:alert(1)", "https://user:pw@shop.example/", "data:text/html,x", "not a url"]) expect(httpsLink(bad), bad).toBeNull();
  });

  it("makes a link's label inside a line a link, with its host beside it", () => {
    const m = { text: "Elm Hall TICKETS HERE\nTake the Band Quiz CLICK HERE and see https://band.example/faq.\nTrack at fedex.com today", links: [
      { text: "TICKETS HERE", url: "https://tickets.example/e/1" },
      { text: "Band Quiz CLICK HERE", url: "https://quiz.example/" },
      { text: "Track at fedex.com", url: "https://evil.example/t" },
      { text: "x", url: "https://too-short.example/" },
    ] };
    const lines = messageLines(m);
    expect(lines[0].parts).toEqual([{ text: "Elm Hall " }, { text: "TICKETS HERE", href: "https://tickets.example/e/1", host: "tickets.example" }]);
    expect(lines[1].parts).toEqual([
      { text: "Take the " }, { text: "Band Quiz CLICK HERE", href: "https://quiz.example/", host: "quiz.example" },
      { text: " and see " }, { text: "https://band.example/faq", href: "https://band.example/faq" }, { text: "." },
    ]);
    expect(lines[2].parts?.some((p) => p.href), "a label naming another site than its link is no link").toBe(false);
    expect(lines.flatMap((l) => l.parts ?? []).some((p) => p.href?.includes("too-short")), "a one-letter label is no link").toBe(false);
  });

  it("makes the https addresses written in a message links, the address itself as their text", () => {
    expect(textParts("See https://example.com/a?b=1. Thanks")).toEqual([
      { text: "See " }, { text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" }, { text: ". Thanks" },
    ]);
    expect(textParts("Visit www.shop.example, or not")[1]).toEqual({ text: "www.shop.example", href: "https://www.shop.example/" });
    expect(textParts("(https://en.wikipedia.example/wiki/Tea_(drink))")[1].text, "a bracket the address opened stays").toBe("https://en.wikipedia.example/wiki/Tea_(drink)");
    expect(textParts("(see https://example.com/x)")[1].text, "a bracket it did not open goes").toBe("https://example.com/x");
    expect(textParts("Plain text, no address.")).toEqual([{ text: "Plain text, no address." }]);
    for (const bad of ["http://example.com", "http://www.example.com", "javascript:alert(1)", "https://user:pw@example.com/", "mailto:a@b.example", "me@www.example.com", "https://localhost/x", "data:text/html,x"]) {
      expect(textParts(`x ${bad} y`).some((p) => p.href), bad).toBe(false);
    }
    // Letters from another alphabet that look like Latin ones: the real host is shown beside it.
    expect(textParts("https://\u0430pple.example/login")[0].warnHost).toBe("xn--pple-43d.example");
    expect(textParts("https://apple.example/")[0].warnHost).toBeUndefined();
  });

  it("warns when replies would go somewhere other than the sender", () => {
    expect(replyToWarning({ from: ALEX })).toBeNull();
    expect(replyToWarning({ from: ALEX, reply_to: "ALEX@example.com" })).toBeNull();
    expect(replyToWarning({ from: { name: "Your Bank", address: "alerts@bank.example" }, reply_to: "help@b4nk-support.example" }))
      .toBe("Replies go to help@b4nk-support.example, not to alerts@bank.example.");
  });

  it("notices a display name that shows another address", () => {
    expect(nameHidesAddress({ name: "support@bank.example", address: "x@evil.example" })).toBe(true);
    expect(nameHidesAddress({ name: "Alex (alex@example.com)", address: "alex@example.com" })).toBe(false);
    expect(nameHidesAddress(ALEX)).toBe(false);
  });

  it("routes", () => {
    expect(SCREEN_MODULE["/mail"]).toBe("mail_inbox");
    expect(moduleOfScreen("/mail")).toBe("mail_inbox");
  });

  it("the Mail screen shows mail HTML only in a frame where nothing runs, and links only what textParts checked", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|renderMarkdown|insertAdjacentHTML|document\.write/);
    // The hub's cleaned page goes in one iframe, sandboxed without scripts, popups, forms or navigation.
    expect(src.match(/<iframe[^>]*>/g)).toEqual([`<iframe ref={ref} className="mailx-frame" title={title} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={doc} />`]);
    expect(src).not.toMatch(/allow-scripts|allow-popups|allow-forms|allow-top-navigation|\.src\s*=/);
    // The only href from outside the app's own screens (#/...) is a piece textParts made and checked.
    expect((src.match(/href=\{[^}]+\}/g) ?? []).filter((h) => !h.startsWith("href={`#")).sort()).toEqual(["href={p.href}"]);
    expect(src.match(/<Parts parts=\{[^}]+\}/g)).toEqual(["<Parts parts={textParts(line)}"]);
  });

  it("opens a link from inside a mail only when it is http, https or mailto", () => {
    expect(frameLink("https://shop.example/a")).toBe("https://shop.example/a");
    expect(frameLink("mailto:help@shop.example")).toBe("mailto:help@shop.example");
    expect(frameLink("javascript:alert(1)")).toBeNull();
    expect(frameLink("file:///c:/x")).toBeNull();
    expect(frameLink(null)).toBeNull();
  });
});

describe("mail batches", () => {
  it("a selection of any size goes to the hub 500 at a time", async () => {
    const { batches, BATCH_MAX } = await import("./mail");
    const ids = Array.from({ length: 1201 }, (_, i) => String(i));
    const parts = batches(ids);
    expect(parts.map((p) => p.length)).toEqual([BATCH_MAX, BATCH_MAX, 201]);
    expect(parts.flat()).toEqual(ids);
    expect(batches([])).toEqual([]);
  });
});

describe("mail cards", () => {
  it("says a card's facts in one line, in the order a person looks for them", () => {
    expect(cardLine({ kind: "package", source: "text", title: "UPS", number: "1Z999AA10123456784" })).toBe("UPS · 1Z999AA10123456784");
    expect(cardLine({ kind: "flight", source: "sender", title: "Example Air", number: "EA 110", from: "SFO", to: "JFK" })).toBe("EA 110 · SFO → JFK");
    expect(cardLine({ kind: "bill", source: "text", title: "City Water", amount: "$61.50", at: "2026-12-15" })).toBe(`City Water · $61.50 due · By ${cardTime("2026-12-15")}`);
    expect(cardLine({ kind: "order", source: "sender" })).toBe("");
  });

  it("shows a day without a time as that day wherever the device is", () => {
    // A day is read as the device's own midnight, never as UTC's (which is the day before in the Americas).
    expect(cardTime("2026-12-15")).toBe(new Date(2026, 11, 15).toLocaleString([], { weekday: "short", month: "short", day: "numeric" }));
    expect(cardTime("2026-12-03T16:00:00.000Z")).toMatch(/\d:\d\d/);
    expect(cardTime("soon")).toBe("");
  });

  it("opens a card's link only when it is https", () => {
    expect(cardLink({ kind: "package", source: "sender", url: "https://track.example/1" })).toBe("https://track.example/1");
    expect(cardLink({ kind: "package", source: "sender", url: "http://track.example/1" })).toBeNull();
    expect(cardLink({ kind: "package", source: "sender", url: "javascript:alert(1)" })).toBeNull();
    expect(cardLink({ kind: "package", source: "sender", url: "https://a:b@track.example/1" })).toBeNull();
    expect(cardLink({ kind: "package", source: "text" })).toBeNull();
  });
});

describe("mail swipes", () => {
  it("is a swipe only once it moves clearly sideways, so scrolling never swipes", () => {
    expect(swipeLock(6, 2)).toBeNull();
    expect(swipeLock(30, 5)).toBe("h");
    expect(swipeLock(-30, 5)).toBe("h");
    expect(swipeLock(20, 18)).toBe("v");
    expect(swipeLock(2, 40)).toBe("v");
  });

  it("acts only when let go far enough: right is Done, left is Snooze", () => {
    expect(swipeAction(130, 375)).toBe("done");
    expect(swipeAction(-130, 375)).toBe("snooze");
    expect(swipeAction(80, 375)).toBeNull();
    expect(swipeAction(-80, 375)).toBeNull();
    expect(swipeAction(75, 200)).toBe("done");
    expect(swipeAction(60, 200)).toBeNull();
  });
});

describe("mail trips", () => {
  const mail = (id: string, cards: MailCard[]): MailSummary => ({ id, at: "2026-11-20T12:00:00Z", from: { name: "", address: "x@air.example" }, subject: id, preview: "", automated: true, bundle: "trips", state: "inbox", pinned: false, seen: true, cards });
  const out = mail("out", [{ kind: "flight", source: "sender", number: "EA 110", from: "SFO", to: "JFK", at: "2026-12-03T16:00:00Z", until: "2026-12-03T21:30:00Z" }]);
  const hotel = mail("hotel", [{ kind: "stay", source: "sender", title: "Harbor Inn", at: "2026-12-03", until: "2026-12-06" }]);
  const back = mail("back", [{ kind: "flight", source: "sender", number: "EA 111", from: "JFK", to: "SFO", at: "2026-12-06T18:00:00Z" }]);
  const now = Date.parse("2026-11-20T12:00:00Z");

  it("groups the flight out, the hotel and the flight back as one trip, named by where the first flight lands", () => {
    const [t, ...others] = tripsOf([back, hotel, out], now);
    expect(others).toEqual([]);
    expect(t.name).toBe("Trip to JFK");
    expect(t.parts.map((p) => p.mail.id)).toEqual(["out", "hotel", "back"]);
    expect(tripDates(t)).toBe(`${new Date(2026, 11, 3).toLocaleDateString([], { month: "short", day: "numeric" })} to 6`);
  });

  it("needs two mails, never starts with a booking, and keeps trips weeks apart separate", () => {
    expect(tripsOf([out], now)).toEqual([]);
    const dinner = mail("dinner", [{ kind: "table", source: "sender", title: "Bistro", at: "2026-11-28T19:00:00Z" }]);
    const show = mail("show", [{ kind: "event", source: "sender", title: "Concert", at: "2026-11-28T21:00:00Z" }]);
    expect(tripsOf([dinner, show], now)).toEqual([]); // a dinner and a show at home are no trip
    const later = mail("later", [{ kind: "stay", source: "sender", title: "Lake Lodge", at: "2027-01-10", until: "2027-01-12" }]);
    const car = mail("car", [{ kind: "booking", source: "sender", title: "Car hire", at: "2027-01-10T15:00:00Z" }]);
    expect(tripsOf([out, hotel, back, later, car], now).map((t) => t.name)).toEqual(["Trip to JFK", "Stay at Lake Lodge"]);
  });

  it("lists trips not over yet first, the soonest first, then past ones", () => {
    const old1 = mail("o1", [{ kind: "flight", source: "sender", to: "LAX", at: "2026-10-01T10:00:00Z" }]);
    const old2 = mail("o2", [{ kind: "stay", source: "sender", title: "Beach Hotel", at: "2026-10-01", until: "2026-10-04" }]);
    expect(tripsOf([old1, old2, out, hotel], now).map((t) => t.name)).toEqual(["Trip to JFK", "Trip to LAX"]);
  });

  it("ignores cards without a date, and cards read from text", () => {
    const conf = mail("conf", [{ kind: "booking", source: "text", number: "X7K2PQ" }]);
    expect(tripsOf([out, conf], now)).toEqual([]);
  });
});

describe("mail folders", () => {
  const f = (role: MailFolder["role"], name = "x", count = 3, unread = 2): MailFolder => ({ key: "k", email: "robin@icloud.example", role, name, count, unread, more: false });
  it("names iCloud's folders as the screen does (Junk is Spam), and the owner's by their own name", () => {
    expect([f("drafts"), f("sent"), f("junk"), f("trash"), f("own", "Taxes")].map((x) => folderLabel(x))).toEqual(["Drafts", "Sent", "Spam", "Trash", "Taxes"]);
    expect(folderLabel(f("sent"), true)).toBe("Sent (robin@icloud.example)");
  });
  it("counts drafts, and unread mail where it matters (not in Sent or Trash)", () => {
    expect([f("drafts"), f("sent"), f("junk"), f("trash"), f("own")].map(folderCount)).toEqual([3, 0, 2, 0, 2]);
  });
  it("names who the owner wrote to for Sent and Drafts, else the sender", () => {
    const m = (folder_role: MailFolder["role"]): FolderMail => ({ id: "1", at: "2026-11-20T10:00:00Z", from: { name: "Robin", address: "robin@icloud.example" }, to: [{ name: "Alex", address: "alex@example.com" }, { name: "", address: "sam@example.com" }], subject: "Hi", preview: "", automated: false, bundle: null, state: "folder", pinned: false, folder_role });
    expect(folderWho(m("sent"))).toBe("To: Alex, sam@example.com");
    expect(folderWho(m("junk"))).toBe("Robin");
  });
});

describe("mail move keys", () => {
  const k = (key: string) => mailKeyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, false);
  it("Delete and Backspace delete, ! is spam, never while typing", () => {
    expect([k("Delete"), k("Backspace"), k("!")]).toEqual(["delete", "delete", "spam"]);
    expect(mailKeyAction({ key: "Backspace", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, true)).toBeNull();
    expect(MAIL_KEYS.some((x) => x.keys === "Delete") && MAIL_KEYS.some((x) => x.keys === "!")).toBe(true);
  });
});

describe("mail attachments", () => {
  it("shows a preview only for a data: JPEG, PNG, GIF or WebP", () => {
    expect(previewSrc("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    for (const bad of ["data:image/svg+xml;base64,PHN2Zz4=", "https://evil.example/x.png", "data:text/html;base64,PHNjcmlwdD4=", "javascript:alert(1)", undefined]) expect(previewSrc(bad)).toBeNull();
  });
  it("warns before files that can run programs", () => {
    for (const n of ["setup.exe", "invoice.pdf.exe", "run.JS", "report.xlsm", "photo.lnk", "disk.iso"]) expect(riskyFile(n)).toBe(true);
    for (const n of ["photo.jpg", "tickets.pdf", "notes.txt", "budget.xlsx"]) expect(riskyFile(n)).toBe(false);
  });
  it("says sizes as people read them", () => {
    expect([fileSize(512), fileSize(840_000), fileSize(2_500_000), fileSize(25_000_000)]).toEqual(["512 B", "820 KB", "2.4 MB", "24 MB"]);
  });
});

describe("mail search hits", () => {
  it("names where a hit is", () => {
    expect(whereLabel({ where: "inbox", state: "inbox" })).toBe("Inbox");
    expect(whereLabel({ where: "junk", state: "folder" })).toBe("Spam");
    expect(whereLabel({ where: "sent", state: "sent" })).toBe("Your reply");
    expect(whereLabel({ where: "sent", state: "folder" })).toBe("Sent");
    expect(whereLabel({ where: "own", folder_name: "Taxes", state: "folder" })).toBe("Taxes");
  });
});

describe("mail triage digest", () => {
  const m = (id: string, at: string, triage?: MailSummary["triage"], state: MailSummary["state"] = "inbox"): MailSummary => ({ id, at, from: { name: "", address: "a@x.example" }, subject: id, preview: "", automated: false, bundle: null, state, pinned: false, ...(triage ? { triage } : {}) });
  it("today's first, then those needing a reply, never done or untriaged mail, at most 5", () => {
    const list = [
      m("reply-old", "2026-11-19T10:00:00Z", { urgency: "soon", needs_reply: true }),
      m("today", "2026-11-18T10:00:00Z", { urgency: "today", needs_reply: false }),
      m("reply-new", "2026-11-20T10:00:00Z", { urgency: "fyi", needs_reply: true }),
      m("low", "2026-11-20T11:00:00Z", { urgency: "low", needs_reply: false }),
      m("done", "2026-11-20T12:00:00Z", { urgency: "today", needs_reply: true }, "done"),
      m("plain", "2026-11-20T13:00:00Z"),
    ];
    expect(needsYou(list).map((x) => x.id)).toEqual(["today", "reply-new", "reply-old"]);
    expect(needsYou(Array.from({ length: 9 }, (_, i) => m(`t${i}`, `2026-11-2${i % 9}T10:00:00Z`, { urgency: "today", needs_reply: false })))).toHaveLength(5);
  });
});
