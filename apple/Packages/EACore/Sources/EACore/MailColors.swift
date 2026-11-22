import Foundation

/// The Mail screen's own colors, in one place: the same as the web's (`--b-*` and `--bt-*` in web/src/styles.css, and
/// the owner's bundles' `.b-custom.ccN`), so a color means the same place in every app.
///
/// Each place (Inbox, Snoozed, Done, every bundle) has a fill that carries white at 4.5:1 (the title, a bundle's icon,
/// a sender's initials), the same in every app theme, and a word shade (a bundle's name, its link) that reads at 4.5:1
/// on the page and on a row. In a theme other than Classic a word shade that would not read there moves toward the
/// theme's text color until it does, as status colors do (`FeelColor.readable`).
public enum MailColors {
    public struct Pair: Equatable, Sendable {
        public var light: String
        public var dark: String
        public func pick(dark isDark: Bool) -> String { isDark ? dark : light }
    }

    /// Fills that carry white words and icons.
    public static let fills: [String: Pair] = [
        "inbox": Pair(light: "#2F5FBF", dark: "#33569E"),
        "snoozed": Pair(light: "#9E6910", dark: "#9A6A14"),
        "done": Pair(light: "#358252", dark: "#2F7A4B"),
        "purchases": Pair(light: "#2A7F50", dark: "#318256"),
        "trips": Pair(light: "#7048C0", dark: "#7D5CC9"),
        "social": Pair(light: "#C9413F", dark: "#C1514E"),
        "promos": Pair(light: "#4D7C0F", dark: "#58801D"),
        "bills": Pair(light: "#1F6F43", dark: "#2F7D52"),
        "pet": Pair(light: "#B55D18", dark: "#AA6229"),
        "jobs": Pair(light: "#4352B8", dark: "#5767C8"),
        "other": Pair(light: "#5D6470", dark: "#6B7280"),
    ]

    /// The same colors as words, on the page and a row.
    public static let words: [String: Pair] = [
        "inbox": Pair(light: "#2F5FBF", dark: "#7B98D4"),
        "snoozed": Pair(light: "#8F5F0E", dark: "#CC8C1A"),
        "done": Pair(light: "#30764B", dark: "#42AB69"),
        "purchases": Pair(light: "#27764B", dark: "#40AB71"),
        "trips": Pair(light: "#7048C0", dark: "#A38CD9"),
        "social": Pair(light: "#BE3735", dark: "#D38280"),
        "promos": Pair(light: "#48740E", dark: "#73A826"),
        "bills": Pair(light: "#1F6F43", dark: "#40AB70"),
        "pet": Pair(light: "#A25315", dark: "#D38649"),
        "jobs": Pair(light: "#4352B8", dark: "#8994D8"),
        "other": Pair(light: "#5D6470", dark: "#9399A5"),
    ]

    /// The owner's own bundles: eight colors of their own, apart from the built-in bundles' (white words on each),
    /// the same in light and dark as on the web.
    public static let custom = ["#0F7C86", "#2F6FD0", "#A83E8E", "#8A5A2B", "#5560A8", "#C2416B", "#127A9C", "#8A7410"]

    /// The key a place's colors are kept under: a view, or a bundle (the owner's by its color).
    public enum Key: Hashable, Sendable {
        case place(String)
        case custom(Int)
    }

    public static func key(_ place: Mail.Place) -> Key {
        switch place {
        case .inbox: return .place("inbox")
        case .snoozed: return .place("snoozed")
        case .done: return .place("done")
        case .bundle(let id): return .place(id)
        }
    }

    public static func key(_ b: Mail.Bundle) -> Key { b.custom.map { .custom($0) } ?? .place(b.id) }

    /// The fill for a place: white words read on it in light and dark.
    public static func fill(_ k: Key, dark: Bool) -> String {
        switch k {
        case .custom(let i): return custom[((i % custom.count) + custom.count) % custom.count]
        case .place(let id): return (fills[id] ?? fills["other"]!).pick(dark: dark)
        }
    }

    /// Classic's backgrounds under Mail's words: the system's grouped page and row on the iPhone and iPad, and the
    /// window and control colors on the Mac, in light or dark; with the system's text color.
    public static func systemBackgrounds(dark: Bool) -> [String] {
        dark ? ["#000000", "#1C1C1E", "#2C2C2E", "#1E1E1E", "#323232"] : ["#F2F2F7", "#FFFFFF", "#ECECEC"]
    }
    public static func systemText(dark: Bool) -> String { dark ? "#FFFFFF" : "#000000" }

    /// A place's color as words on `backgrounds` (the page and a row), moved toward `text` until it reads at 4.5:1.
    public static func word(_ k: Key, dark: Bool, text: String, backgrounds: [String]) -> String {
        let base: String
        switch k {
        case .custom: base = fill(k, dark: dark)
        case .place(let id): base = (words[id] ?? words["other"]!).pick(dark: dark)
        }
        return FeelColor.readable(base, text: text, on: backgrounds)
    }
}
