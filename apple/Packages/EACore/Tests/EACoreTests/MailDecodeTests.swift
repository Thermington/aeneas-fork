import XCTest
@testable import EACore

/// The `/mail` answers as the hub sends them (hub/src/routes/mail.ts, CONTRACT.md Mail), made-up mail only, and the
/// bodies the app sends back.
final class MailDecodeTests: XCTestCase {
    func testDecodesTheListWithEverySetting() throws {
        let json = """
        {"messages":[
          {"id":"a1b2c3d4e5f6a1b2c3d4e5f6","at":"2026-11-19T14:00:00.000Z","from":{"name":"Northwind Coffee","address":"orders@northwind.example"},
           "subject":"Your order is on its way","preview":"Order 48213 left our roastery.","automated":true,"bundle":"purchases","state":"inbox",
           "pinned":false,"logo_domain":"northwind.example","seen":false,"thread":"0123456789abcdef"},
          {"id":"b1","at":"2026-11-18T10:00:00.000Z","from":{"name":"Robin","address":"robin@icloud.example"},"subject":"Re: Gutters",
           "preview":"Yes","automated":false,"bundle":null,"state":"sent","pinned":false,"seen":true,"thread":"t1","mine":true},
          {"id":"c1","at":"2026-11-17T10:00:00.000Z","from":{"name":"Alex","address":"alex@example.com"},"reply_to":"help@else.example","subject":"Photos",
           "preview":"","automated":false,"bundle":null,"state":"snoozed","pinned":true,"snooze_until":"2026-11-20T13:00:00.000Z","back_at":"2026-11-19T08:00:00.000Z","seen":true},
          {"id":"d1","at":"2026-11-17T10:00:00.000Z","from":{"name":"X","address":"x@y.example"},"subject":"A state from a newer hub","state":"archived"}
        ],
        "logos":{"northwind.example":"data:image/svg+xml;base64,PHN2Zy8+"},
        "mailboxes":[{"email":"robin@icloud.example","last_refresh":"2026-11-19T14:05:00.000Z","last_error":null,"more":true}],
        "snooze_times":{"later_hours":2,"tomorrow":"07:30","weekend_day":0,"weekend_time":"10:00","week_day":1,"week_time":"08:00"},
        "bundle_delivery":{"promos":{"mode":"daily","time":"07:00"},"social":{"mode":"never"},"trips":{"mode":"weekly","time":"18:00","day":0}},
        "custom_bundles":[{"id":"c-0123456789","name":"School","color":3,"addresses":[],"domains":["school.example"],"words":["field trip"]}],
        "mail_notify":{"people":false,"bundles":["promos"],"detail":"sender"}}
        """
        let l = try JSONCoding.decode(MailList.self, from: json)
        XCTAssertEqual(l.messages.count, 4)
        let m = l.messages[0]
        XCTAssertEqual(m.from.name, "Northwind Coffee")
        XCTAssertEqual(m.bundle, "purchases")
        XCTAssertEqual(m.seen, false)
        XCTAssertEqual(m.logo_domain, "northwind.example")
        XCTAssertNil(m.reply_to)
        XCTAssertEqual(l.messages[1].state, .sent)
        XCTAssertTrue(l.messages[1].isMine)
        XCTAssertEqual(l.messages[2].snooze_until, "2026-11-20T13:00:00.000Z")
        XCTAssertEqual(l.messages[2].reply_to, "help@else.example")
        XCTAssertEqual(l.messages[3].state, .done, "a state a newer hub adds never shows in the Inbox")
        XCTAssertEqual(l.messages[3].automated, false)
        XCTAssertNotNil(Mail.logoData(l.logos["northwind.example"]))
        XCTAssertEqual(l.mailboxes, [MailMailbox(email: "robin@icloud.example", last_refresh: "2026-11-19T14:05:00.000Z", last_error: nil, more: true)])
        XCTAssertEqual(l.snooze_times.later_hours, 2)
        XCTAssertEqual(l.bundle_delivery["promos"], MailBundleDelivery(mode: .daily, time: "07:00"))
        XCTAssertEqual(l.bundle_delivery["social"]?.mode, .never)
        XCTAssertEqual(l.bundle_delivery["trips"]?.day, 0)
        XCTAssertEqual(l.custom_bundles.first?.words, ["field trip"])
        XCTAssertEqual(l.mail_notify, MailNotify(people: false, bundles: ["promos"], detail: .sender))
    }

    func testAnOlderHubsListGivesTheDefaults() throws {
        let l = try JSONCoding.decode(MailList.self, from: #"{"messages":[{"id":"x","at":"2026-11-19T14:00:00.000Z","from":{"name":"","address":"a@b.example"},"subject":"Hi","preview":"","automated":false,"bundle":null,"state":"inbox","pinned":false}],"logos":{},"mailboxes":[]}"#)
        XCTAssertNil(l.messages[0].seen, "an older hub leaves seen out: then it shows as read")
        XCTAssertFalse(Mail.isUnread(l.messages[0]))
        XCTAssertEqual(l.snooze_times, .defaults)
        XCTAssertEqual(l.mail_notify, .defaults)
        XCTAssertTrue(l.bundle_delivery.isEmpty)
        XCTAssertTrue(l.custom_bundles.isEmpty)
    }

    func testDecodesOneMessageWithItsPageAndQuote() throws {
        let json = """
        {"id":"a1","at":"2026-11-19T14:00:00.000Z","from":{"name":"Alex","address":"alex@example.com"},"subject":"Gutters","preview":"Can you help",
         "automated":false,"bundle":null,"state":"inbox","pinned":false,"seen":true,"text":"Can you help?\\n\\nOn Monday, Robin wrote:\\n> Sure",
         "html":"<!doctype html><html><body class=\\"aeneas-fold\\"><p>Can you help?</p></body></html>","pictures_pending":false,"pictures_ask":true,"quote_at":15}
        """
        let m = try JSONCoding.decode(MailMessage.self, from: json)
        XCTAssertEqual(m.summary.id, "a1")
        XCTAssertEqual(m.summary.subject, "Gutters")
        XCTAssertTrue(m.pictures_ask)
        XCTAssertFalse(m.pictures_pending)
        XCTAssertEqual(m.quote_at, 15)
        XCTAssertEqual(m.ownText, "Can you help?")
        XCTAssertTrue(m.html?.contains("aeneas-fold") ?? false)
        let plain = try JSONCoding.decode(MailMessage.self, from: #"{"id":"b","at":"","from":{"name":"","address":""},"subject":"","preview":"","automated":true,"bundle":null,"state":"done","pinned":false,"seen":true,"text":"Hi","html":null,"pictures_pending":false,"pictures_ask":false}"#)
        XCTAssertNil(plain.html)
        XCTAssertNil(plain.quote_at)
    }

    func testDecodesWhatTheActionsAnswer() throws {
        let moved = try JSONCoding.decode(MailMoved.self, from: #"{"moved":["a","b"],"failed":1,"error":"iCloud did not answer"}"#)
        XCTAssertEqual(moved, MailMoved(moved: ["a", "b"], failed: 1, error: "iCloud did not answer"))
        let r = try JSONCoding.decode(MailRefresh.self, from: #"{"mailboxes":[{"email":"a@icloud.example","kept":3,"gone":1,"more":false},{"email":"b@icloud.example","kept":2,"gone":0,"more":true}]}"#)
        XCTAssertEqual(r.summary.ok, true)
        XCTAssertEqual(r.summary.text, "5 new.")
        let bad = try JSONCoding.decode(MailRefresh.self, from: #"{"mailboxes":[{"email":"a@icloud.example","error":"The password was refused"}]}"#)
        XCTAssertEqual(bad.summary.ok, false)
        XCTAssertEqual(bad.summary.text, "A mailbox could not be refreshed. Mailboxes and settings has why.")
        XCTAssertEqual(try JSONCoding.decode(MailRefresh.self, from: #"{"mailboxes":[]}"#).summary.text, "Nothing new.")
    }

    /// The bodies the app sends: what the hub's routes read, and nothing else.
    func testSendsTheBodiesTheHubReads() async throws {
        final class Seen: HubTransport, @unchecked Sendable {
            var calls: [(String, String, String)] = []
            func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
                calls.append((method, path, body.map { String(decoding: $0, as: UTF8.self) } ?? ""))
                if path == "mail/settings/notify" { return (200, Data(#"{"people":true,"bundles":["promos"],"detail":"full"}"#.utf8)) }
                if path.hasPrefix("mail/settings/bundles/") { return (200, Data(#"{"promos":{"mode":"never"}}"#.utf8)) }
                if path == "mail/done" { return (200, Data(#"{"moved":["a"],"failed":0}"#.utf8)) }
                return (200, Data(#"{"ok":true}"#.utf8))
            }
        }
        let t = Seen()
        let c = HubClient(transport: t)
        _ = try await c.mailDone(["a"])
        try await c.mailSeen(["a", "b"], seen: true)
        try await c.mailSeen("a", seen: false)
        try await c.mailPin("a", pinned: true)
        try await c.mailSnooze("a", until: Date(timeIntervalSince1970: 1_800_000_000))
        try await c.mailNotify(bundle: "promos", on: true)
        try await c.mailBundleDelivery("promos", MailBundleDelivery(mode: .never))
        XCTAssertEqual(t.calls.map { "\($0.0) \($0.1) \($0.2)" }, [
            #"POST mail/done {"ids":["a"]}"#,
            #"POST mail/seen {"ids":["a","b"],"seen":true}"#,
            #"POST mail/messages/a/seen {"seen":false}"#,
            #"POST mail/messages/a/pin {"pinned":true}"#,
            #"POST mail/messages/a/snooze {"until":"2027-01-15T08:00:00.000Z"}"#,
            #"PUT mail/settings/notify {"bundle":"promos","on":true}"#,
            #"PUT mail/settings/bundles/promos {"mode":"never"}"#,
        ])
    }
}
