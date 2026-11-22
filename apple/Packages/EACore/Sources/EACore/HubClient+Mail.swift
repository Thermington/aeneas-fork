import Foundation

private struct IdsBody: Encodable { var ids: [String] }
private struct SeenManyBody: Encodable { var ids: [String]; var seen: Bool }
private struct SeenBody: Encodable { var seen: Bool }
private struct PinBody: Encodable { var pinned: Bool }
private struct UntilBody: Encodable { var until: String }
private struct NotifyBody: Encodable { var people: Bool?; var detail: String?; var bundle: String?; var on: Bool? }
private struct BundleBody: Encodable { var name: String; var color: Int; var addresses: [String]; var domains: [String]; var words: [String] }
private struct Empty: Codable {}
private struct Ignored: Decodable {}

// MARK: The Mail screen (module mail_inbox)
// Every answer is kept in memory by the screen only: nothing of a mail is written on the device (the hub sessions keep
// no URL cache, HTTPTransport.sessionConfiguration).
extension HubClient {
    /// A mail's id in a path: the hub's ids are hex, and anything else is escaped so it stays one path part.
    static func mailPath(_ id: String, _ rest: String = "") -> String {
        let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return "mail/messages/\(safe)\(rest)"
    }

    /// A bundle's id in a path (`c-` and hex for the owner's own, a word for the built-in ones).
    private static func bundlePath(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-"))) ?? ""
    }

    public func mailList() async throws -> MailList { try await get("mail", as: MailList.self) }

    public func mailMessage(_ id: String) async throws -> MailMessage { try await get(Self.mailPath(id), as: MailMessage.self) }

    public func mailRefresh() async throws -> MailRefresh { try await post("mail/refresh", Empty(), as: MailRefresh.self) }

    /// Show pictures, on a hub without Tor: the hub fetches this one mail's web pictures straight from its sender,
    /// who then sees the home's internet address. The answer is the message with them written in.
    public func mailShowPictures(_ id: String) async throws -> MailMessage { try await post(Self.mailPath(id, "/pictures"), Empty(), as: MailMessage.self) }

    /// Done: the mails move to Archive in iCloud (a Sweep is many at once). At most `Mail.batchMax` ids.
    public func mailDone(_ ids: [String]) async throws -> MailMoved { try await post("mail/done", IdsBody(ids: ids), as: MailMoved.self) }

    /// Undo, or Move to Inbox from Done: the mails move back from Archive to the Inbox.
    public func mailUndo(_ ids: [String]) async throws -> MailMoved { try await post("mail/undo", IdsBody(ids: ids), as: MailMoved.self) }

    /// Snooze a thread until a time: on the hub only, with a task that says only "Snoozed mail".
    public func mailSnooze(_ id: String, until: Date) async throws {
        _ = try await post(Self.mailPath(id, "/snooze"), UntilBody(until: ISO.string(until)), as: Ignored.self)
    }

    /// Back to the Inbox now; its task is deleted.
    public func mailUnsnooze(_ id: String) async throws { _ = try await post(Self.mailPath(id, "/unsnooze"), Empty(), as: Ignored.self) }

    /// Several messages read or unread with one request (a thread's unread mails, a selection): at most `Mail.batchMax`.
    public func mailSeen(_ ids: [String], seen: Bool) async throws { _ = try await post("mail/seen", SeenManyBody(ids: ids, seen: seen), as: Ignored.self) }

    /// One message read or unread: on the hub, and in the mailbox (only its read flag).
    public func mailSeen(_ id: String, seen: Bool) async throws { _ = try await post(Self.mailPath(id, "/seen"), SeenBody(seen: seen), as: Ignored.self) }

    /// Pin or unpin a thread: kept on the hub only.
    public func mailPin(_ id: String, pinned: Bool) async throws { _ = try await post(Self.mailPath(id, "/pin"), PinBody(pinned: pinned), as: Ignored.self) }

    /// The owner's own bundles: add, change, delete.
    public func mailBundleAdd(name: String, color: Int, addresses: [String], domains: [String], words: [String]) async throws -> MailCustomBundle {
        try await post("mail/settings/custom-bundles", BundleBody(name: name, color: color, addresses: addresses, domains: domains, words: words), as: MailCustomBundle.self)
    }

    public func mailBundleUpdate(_ b: MailCustomBundle) async throws -> MailCustomBundle {
        try await post("mail/settings/custom-bundles/\(Self.bundlePath(b.id))", BundleBody(name: b.name, color: b.color, addresses: b.addresses, domains: b.domains, words: b.words), as: MailCustomBundle.self, method: "PUT")
    }

    public func mailBundleDelete(_ id: String) async throws {
        _ = try await send("DELETE", "mail/settings/custom-bundles/\(Self.bundlePath(id))")
    }

    /// New-mail notifications: `people`, `detail`, or one bundle's switch (`bundle` with `on`).
    @discardableResult
    public func mailNotify(people: Bool? = nil, detail: MailNotify.Detail? = nil, bundle: String? = nil, on: Bool? = nil) async throws -> MailNotify {
        try await post("mail/settings/notify", NotifyBody(people: people, detail: detail?.rawValue, bundle: bundle, on: on), as: MailNotify.self, method: "PUT")
    }

    /// When a bundle's mail shows in the Inbox.
    @discardableResult
    public func mailBundleDelivery(_ bundle: String, _ d: MailBundleDelivery) async throws -> [String: MailBundleDelivery] {
        try await post("mail/settings/bundles/\(Self.bundlePath(bundle))", d, as: [String: MailBundleDelivery].self, method: "PUT")
    }

    /// The owner's snooze times (what "Tomorrow" and the rest mean).
    @discardableResult
    public func mailSnoozeTimes(_ t: MailSnoozeTimes) async throws -> MailSnoozeTimes {
        try await post("mail/settings/snooze", t, as: MailSnoozeTimes.self, method: "PUT")
    }
}
