import SwiftUI
import EACore

/// What the Mail screen holds while it shows: the hub's list, the messages opened, and the last action's Undo. In
/// memory only and gone with the screen: nothing of a mail is written on the device, put in Spotlight, a widget, a
/// notification or a log (CONTRACT.md, Mail).
@MainActor
final class MailStore: ObservableObject {
    @Published private(set) var list: MailList?
    /// The list's messages as rows: threads, each read as its newest received mail.
    @Published private(set) var threads: [MailThread] = []
    @Published private(set) var loadError: String?
    /// The last action's problem, in the hub's words, at the top of the list.
    @Published var actionError: String?
    /// The last Refresh's result, for a few seconds.
    @Published var refreshNote: (ok: Bool, text: String)?
    @Published private(set) var refreshing = false
    /// The last Done, Sweep or Snooze, for its Undo bar (gone after a few seconds, or with the next one).
    @Published var undo: Undo?
    /// Messages opened, by id, so a thread opened again shows at once.
    @Published private(set) var messages: [String: MailMessage] = [:]

    struct Undo: Identifiable {
        let id = UUID()
        var text: String
        var run: () async -> Void
    }

    private var client: HubClient?
    private var undoTimer: Task<Void, Never>?
    private var noteTimer: Task<Void, Never>?

    func attach(_ c: HubClient?) { client = c }

    var snoozeTimes: MailSnoozeTimes { list?.snooze_times ?? .defaults }
    var delivery: [String: MailBundleDelivery] { list?.bundle_delivery ?? [:] }
    var notify: MailNotify { list?.mail_notify ?? .defaults }
    var customBundles: [MailCustomBundle] { list?.custom_bundles ?? [] }

    func thread(_ id: String) -> MailThread? { threads.first { $0.id == id } }

    func load() async {
        guard let c = client else { loadError = HubError.notConfigured.localizedDescription; return }
        do {
            let l = try await c.mailList()
            if l != list { list = l; threads = Mail.threads(l.messages) }
            loadError = nil
        } catch {
            if list == nil { loadError = error.localizedDescription }
        }
    }

    /// Asks the hub to read the mailboxes now, then shows what came.
    func refresh() async {
        guard let c = client, !refreshing else { return }
        refreshing = true
        refreshNote = nil
        defer { refreshing = false }
        do {
            refreshNote = try await c.mailRefresh().summary
        } catch {
            refreshNote = (false, error.localizedDescription)
        }
        noteTimer?.cancel()
        noteTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            if !Task.isCancelled { self?.refreshNote = nil }
        }
        await load()
    }

    /// Runs one change on the hub, shows its problem if it had one, and loads the list again so every row shows it.
    func act(_ run: (HubClient) async throws -> Void) async {
        guard let c = client else { return }
        actionError = nil
        do { try await run(c) } catch { actionError = error.localizedDescription }
        await load()
    }

    private func offerUndo(_ text: String, _ run: @escaping () async -> Void) {
        undo = Undo(text: text, run: run)
        undoTimer?.cancel()
        undoTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            if !Task.isCancelled { self?.undo = nil }
        }
    }

    /// Done (to Archive in iCloud) or back to the Inbox, 500 at a time; after Done, an Undo bar.
    func move(_ ids: [String], toDone: Bool) async {
        guard let c = client, !ids.isEmpty else { return }
        actionError = nil
        var moved: [String] = []
        do {
            for part in Mail.batches(ids) {
                let r = toDone ? try await c.mailDone(part) : try await c.mailUndo(part)
                moved += r.moved
                if let e = r.error { actionError = e; break }
            }
        } catch { actionError = error.localizedDescription }
        if toDone, !moved.isEmpty {
            let back = moved
            offerUndo(moved.count == 1 ? "Marked done" : "\(moved.count) marked done") { [weak self] in await self?.move(back, toDone: false) }
        } else if !toDone {
            undo = nil
        }
        await load()
    }

    /// Done for threads, or in Done, back to the Inbox.
    func done(_ ts: [MailThread], inDone: Bool) async {
        await move(ts.flatMap { inDone ? $0.doneIds : $0.openIds }, toDone: !inDone)
    }

    /// Sweep: every unpinned thread here marked done at once (pinned ones stay), with one Undo.
    static func sweepIds(_ ts: [MailThread]) -> [String] { ts.filter { !$0.pinned && $0.state != .done }.flatMap(\.openIds) }

    func snooze(_ ts: [MailThread], until: Date) async {
        guard let c = client, !ts.isEmpty else { return }
        actionError = nil
        var done: [MailThread] = []
        do {
            for t in ts where t.state != .done { try await c.mailSnooze(t.id, until: until); done.append(t) }
        } catch { actionError = error.localizedDescription }
        if !done.isEmpty {
            let when = until.formatted(.dateTime.weekday(.abbreviated).hour().minute())
            offerUndo(done.count == 1 ? "Snoozed until \(when)" : "\(done.count) snoozed until \(when)") { [weak self] in
                await self?.act { c in for t in done { try await c.mailUnsnooze(t.id) } }
            }
        }
        await load()
    }

    func unsnooze(_ t: MailThread) async { await act { try await $0.mailUnsnooze(t.id) } }

    /// Pin or unpin: all pinned when any is not.
    func pin(_ ts: [MailThread]) async {
        let to = !ts.allSatisfy(\.pinned)
        await act { c in for t in ts { try await c.mailPin(t.id, pinned: to) } }
    }

    /// Mark read (the threads' unread mail) or unread (each thread's newest received mail), 500 at a time.
    func read(_ ts: [MailThread], _ read: Bool) async {
        let ids = ts.flatMap { read ? $0.unreadIds : [$0.id] }
        guard !ids.isEmpty else { return }
        await act { c in for part in Mail.batches(ids) { try await c.mailSeen(part, seen: read) } }
    }

    /// A message whole, from memory or the hub.
    func message(_ id: String) async throws -> MailMessage {
        if let m = messages[id] { return m }
        guard let c = client else { throw HubError.notConfigured }
        let m = try await c.mailMessage(id)
        messages[id] = m
        return m
    }

    /// Show pictures (a hub without Tor): the hub fetches this mail's pictures now, and the mail comes back with them.
    func showPictures(_ id: String) async throws -> MailMessage {
        guard let c = client else { throw HubError.notConfigured }
        let m = try await c.mailShowPictures(id)
        messages[id] = m
        return m
    }

    func setSnoozeTimes(_ t: MailSnoozeTimes) async { await act { _ = try await $0.mailSnoozeTimes(t) } }
    func setDelivery(_ bundle: String, _ d: MailBundleDelivery) async { await act { _ = try await $0.mailBundleDelivery(bundle, d) } }
    func setNotify(people: Bool? = nil, detail: MailNotify.Detail? = nil, bundle: String? = nil, on: Bool? = nil) async {
        await act { _ = try await $0.mailNotify(people: people, detail: detail, bundle: bundle, on: on) }
    }

    /// A bundle of the owner's made or changed; its id, to show it.
    func saveBundle(_ b: MailCustomBundle, isNew: Bool) async throws -> String {
        guard let c = client else { throw HubError.notConfigured }
        let saved = isNew ? try await c.mailBundleAdd(name: b.name, color: b.color, addresses: b.addresses, domains: b.domains, words: b.words)
                          : try await c.mailBundleUpdate(b)
        await load()
        return saved.id
    }

    func deleteBundle(_ id: String) async throws {
        guard let c = client else { throw HubError.notConfigured }
        try await c.mailBundleDelete(id)
        await load()
    }
}
