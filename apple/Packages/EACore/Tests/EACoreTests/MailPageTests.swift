#if os(macOS)
import XCTest
import WebKit
import Network
@testable import EACore

/// The mail view as the app makes it (MailPageController), given a hostile page with none of the hub's cleaning and
/// none of its policy: nothing in it runs, nothing loads, nothing navigates, and only a tapped http, https or mailto
/// link is handed out (to open outside the app). Loads are aimed at a listener on this Mac, which counts every
/// connection, and at example.com, which the page's own timing list would show.
@MainActor
final class MailPageTests: XCTestCase {
    /// Counts the connections made to it.
    final class Listener: @unchecked Sendable {
        let listener: NWListener
        private let lock = NSLock()
        private var count = 0
        var connections: Int { lock.withLock { count } }

        init() throws {
            let p = NWParameters.tcp
            p.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
            listener = try NWListener(using: p)
            listener.newConnectionHandler = { [weak self] c in
                self?.lock.withLock { self?.count += 1 }
                c.cancel()
            }
        }

        func start() async -> UInt16 {
            await withCheckedContinuation { (k: CheckedContinuation<UInt16, Never>) in
                listener.stateUpdateHandler = { [listener] s in
                    if case .ready = s { listener.stateUpdateHandler = nil; k.resume(returning: listener.port?.rawValue ?? 0) }
                }
                listener.start(queue: .main)
            }
        }
    }

    private func hostile(_ port: UInt16) -> String {
        let here = "http://127.0.0.1:\(port)"
        return """
        <!doctype html><html><head>
        <meta http-equiv="refresh" content="0;url=\(here)/refresh">
        <link rel="stylesheet" href="\(here)/css">
        <link rel="prefetch" href="\(here)/prefetch">
        <style>@import url(\(here)/import); body { background: url(\(here)/bg); } @font-face { font-family: x; src: url(\(here)/font); } p { font-family: x; }</style>
        <script src="\(here)/script.js"></script>
        <base href="\(here)/base/">
        </head><body>
        <script>document.title = 'script ran'; document.body.setAttribute('data-ran', 'script');</script>
        <img src="x" onerror="document.title = 'onerror ran'">
        <img src="\(here)/img" onerror="document.body.setAttribute('data-ran', 'onerror')">
        <img src="https://example.com/x">
        <img srcset="\(here)/srcset 2x">
        <iframe src="\(here)/frame"></iframe>
        <iframe srcdoc="<script>parent.document.title='frame ran'</script>"></iframe>
        <object data="\(here)/object"></object><embed src="\(here)/embed"><video src="\(here)/video" autoplay></video><audio src="\(here)/audio" autoplay></audio>
        <svg><image href="\(here)/svgimage"/></svg>
        <form id="f" action="\(here)/form" method="post"><input name="a" value="b"><button id="go">Go</button></form>
        <a id="js" href="javascript:document.title='link ran'">a link to javascript</a>
        <a id="data" href="data:text/html,<script>alert(1)</script>">a link to data</a>
        <a id="file" href="file:///etc/hosts">a link to a file</a>
        <a id="web" href="https://shop.example/orders/1">a link to a shop</a>
        <a id="mail" href="mailto:help@shop.example">a mail link</a>
        <p>Hello from the mail.</p>
        <blockquote type="cite">An older message</blockquote>
        </body></html>
        """
    }

    private func pause(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

    private func appWorld(_ js: String, _ page: MailPageController, _ args: [String: Any] = [:]) async throws -> Any? {
        try await page.webView.callAsyncJavaScript(js, arguments: args, in: nil, contentWorld: MailPageController.world)
    }

    func testAHostilePageRunsNothingLoadsNothingAndNavigatesNowhere() async throws {
        let l = try Listener()
        let port = await l.start()
        XCTAssertGreaterThan(port, 0)
        guard let rules = await MailPageController.ruleList() else { return XCTFail("the rule list compiles") }
        var opened: [URL] = []
        var heights: [Double] = []
        var foldable: Bool?
        let page = MailPageController(configuration: MailPageController.configuration(rules: rules), onOpen: { opened.append($0) }, onHeight: { heights.append($0) }, onFoldable: { foldable = $0 })
        page.webView.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        page.load(hostile(port))
        for _ in 0..<50 where heights.isEmpty { await pause(0.1) }
        await pause(1.5)

        XCTAssertEqual(page.allowedNavigations, 1, "only the page itself")
        XCTAssertFalse(heights.isEmpty, "the page loaded and was measured")
        XCTAssertEqual(foldable, true, "its quote can fold, with something besides it")
        let state = try await appWorld("""
        return { title: document.title, ran: document.body.getAttribute('data-ran'), text: document.body.innerText,
                 resources: performance.getEntriesByType('resource').map((e) => e.name), url: location.href,
                 folded: document.body.classList.contains('aeneas-fold'),
                 linkTitle: document.getElementById('web').getAttribute('title'),
                 viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') };
        """, page) as? [String: Any]
        XCTAssertEqual(state?["title"] as? String, "", "no script, no handler, no frame ran")
        XCTAssertTrue(state?["ran"] is NSNull || state?["ran"] == nil, "no script or handler set anything")
        XCTAssertTrue((state?["text"] as? String)?.contains("Hello from the mail.") ?? false, "the mail shows")
        XCTAssertEqual(state?["folded"] as? Bool, true, "the quoted history is marked folded (the hub's page hides it then)")
        XCTAssertEqual((state?["resources"] as? [String]) ?? ["?"], [], "nothing was fetched, example.com included")
        XCTAssertEqual(state?["url"] as? String, "about:blank", "the page never went anywhere")
        XCTAssertEqual(state?["linkTitle"] as? String, "https://shop.example/orders/1", "a link shows where it goes")
        XCTAssertEqual(state?["viewport"] as? String, "width=device-width, initial-scale=1", "the screen's own script ran, in its own world")

        // Pressing every link and the form's button: nothing navigates in the view and nothing loads; an http, https
        // or mailto link is handed out to open outside the app, nothing else is.
        for id in ["go", "js", "data", "file", "web", "mail"] {
            _ = try await appWorld("document.getElementById(id).click(); return true;", page, ["id": id])
            await pause(0.3)
        }
        _ = try await appWorld("document.getElementById('f').submit(); return true;", page)
        await pause(1.0)
        let after = try await appWorld("return { title: document.title, url: location.href };", page) as? [String: Any]
        XCTAssertEqual(after?["title"] as? String, "")
        XCTAssertEqual(after?["url"] as? String, "about:blank")
        XCTAssertEqual(page.allowedNavigations, 1)
        XCTAssertTrue(opened.allSatisfy { ["https", "http", "mailto"].contains($0.scheme ?? "") }, "\(opened)")
        XCTAssertTrue(Set(opened.map(\.absoluteString)).isSubset(of: ["https://shop.example/orders/1", "mailto:help@shop.example"]), "\(opened)")
        XCTAssertEqual(l.connections, 0, "nothing reached the listener: no picture, style, font, frame, form, refresh or script")
        l.listener.cancel()
    }

    /// A mail sized by its view (height 100%, 110vh) is measured at one point tall, so measuring again and again does
    /// not make it grow; and no mail is taller than `Mail.pageMax`.
    func testAMailSizedByItsViewDoesNotGrowAndNoneIsTallerThanTheCap() async throws {
        guard let rules = await MailPageController.ruleList() else { return XCTFail("the rule list compiles") }
        let page = MailPageController(configuration: MailPageController.configuration(rules: rules), onOpen: { _ in })
        let host = NSView(frame: CGRect(x: 0, y: 0, width: 400, height: 300))
        host.addSubview(page.webView)
        page.webView.frame = host.bounds
        page.setMeasuring = { on in page.webView.frame.size.height = on ? 1 : page.webView.frame.size.height }
        var heights: [Double] = []
        page.onHeight = { h in heights.append(h); page.webView.frame.size.height = h }
        page.load("<!doctype html><html><head><style>html,body{height:100%;margin:0}</style></head><body><div style=\"height:110vh;background:#eee\">Tall</div><p>End</p></body></html>")
        for _ in 0..<50 where heights.isEmpty { await pause(0.1) }
        var again: [Double] = []
        for _ in 0..<4 { again.append(await page.measure()) }
        XCTAssertFalse(heights.isEmpty)
        XCTAssertLessThan(again.max() ?? 1e9, 400, "\(heights) \(again)")
        XCTAssertEqual(Set(again.map { Int($0) }).count, 1, "the same every time: \(again)")

        let long = MailPageController(configuration: MailPageController.configuration(rules: rules), onOpen: { _ in })
        long.webView.frame = CGRect(x: 0, y: 0, width: 400, height: 1)
        var h: [Double] = []
        long.onHeight = { h.append($0) }
        long.load("<!doctype html><html><body><div style=\"height:90000px\">Very long</div></body></html>")
        for _ in 0..<50 where h.isEmpty { await pause(0.1) }
        XCTAssertEqual(h.last, Mail.pageMax)
    }

    /// The quoted history folds as the hub's page folds it (its CSS hides it while the body has `aeneas-fold`), and
    /// unfolds on the screen's button; a mail that is all quote is not folded into a blank page.
    func testQuotedHistoryFoldsAndUnfolds() async throws {
        guard let rules = await MailPageController.ruleList() else { return XCTFail("the rule list compiles") }
        let fold = Mail.quoteSelector.components(separatedBy: ", ").map { "body.aeneas-fold \($0)" }.joined(separator: ",") + "{display:none!important}"
        func page(_ body: String) async -> (MailPageController, () -> [Double], () -> Bool?) {
            let p = MailPageController(configuration: MailPageController.configuration(rules: rules), onOpen: { _ in })
            p.webView.frame = CGRect(x: 0, y: 0, width: 400, height: 1)
            var heights: [Double] = []
            var foldable: Bool?
            p.onHeight = { heights.append($0) }
            p.onFoldable = { foldable = $0 }
            p.load("<!doctype html><html><head><style>\(fold)</style></head><body class=\"aeneas-fold\">\(body)</body></html>")
            for _ in 0..<50 where heights.isEmpty { await pause(0.1) }
            return (p, { heights }, { foldable })
        }
        let reply = await page("<p>Sounds good.</p><blockquote type=\"cite\">" + String(repeating: "<p>An older message</p>", count: 30) + "</blockquote>")
        XCTAssertEqual(reply.2(), true)
        let shut = reply.1().last ?? 0
        reply.0.setUnfolded(true)
        await pause(0.8)
        let open = reply.1().last ?? 0
        XCTAssertGreaterThan(open, shut + 200, "unfolded, the quote shows: \(reply.1())")
        let text = try await appWorld("return document.body.innerText;", reply.0) as? String
        XCTAssertTrue(text?.contains("An older message") ?? false)
        reply.0.setUnfolded(false)
        await pause(0.8)
        XCTAssertEqual(reply.1().last ?? 0, shut, accuracy: 2, "folded again, it is as short as before")

        let forward = await page("<div class=\"gmail_quote\"><p>Only the forwarded mail</p></div>")
        XCTAssertEqual(forward.2(), false, "nothing else would be left: not folded")
        let fwdText = try await appWorld("return document.body.innerText;", forward.0) as? String
        XCTAssertTrue(fwdText?.contains("Only the forwarded mail") ?? false)
    }

    func testOnlyTheFirstLoadGoesThroughAndOnlyATappedLinkIsHandedOut() {
        let blank = URL(string: "about:blank")
        XCTAssertEqual(MailPageController.decide(url: blank, firstLoadDone: false, mainFrame: true, linkTapped: false), .allow)
        XCTAssertEqual(MailPageController.decide(url: blank, firstLoadDone: true, mainFrame: true, linkTapped: false), .cancel(open: nil))
        XCTAssertEqual(MailPageController.decide(url: blank, firstLoadDone: false, mainFrame: false, linkTapped: false), .cancel(open: nil), "a frame inside")
        XCTAssertEqual(MailPageController.decide(url: URL(string: "https://evil.example/"), firstLoadDone: false, mainFrame: true, linkTapped: false), .cancel(open: nil), "a page that is not the mail")
        XCTAssertEqual(MailPageController.decide(url: URL(string: "https://shop.example/a"), firstLoadDone: true, mainFrame: true, linkTapped: true), .cancel(open: URL(string: "https://shop.example/a")))
        XCTAssertEqual(MailPageController.decide(url: URL(string: "https://shop.example/a"), firstLoadDone: true, mainFrame: true, linkTapped: false), .cancel(open: nil), "a refresh or a script never opens anything")
        XCTAssertEqual(MailPageController.decide(url: URL(string: "javascript:alert(1)"), firstLoadDone: true, mainFrame: true, linkTapped: true), .cancel(open: nil))
        XCTAssertEqual(MailPageController.decide(url: URL(string: "file:///etc/hosts"), firstLoadDone: true, mainFrame: true, linkTapped: true), .cancel(open: nil))
    }

    /// The screen's own script is fixed code: what it needs goes in as arguments, so no mail text is ever part of it.
    func testTheScreensScriptIsFixedCode() throws {
        for s in [MailPageController.setupScript, MailPageController.foldScript, MailPageController.measureScript, MailPageController.viewportScript] {
            XCTAssertFalse(s.contains("\\("))
            XCTAssertFalse(s.contains("innerHTML"))
            XCTAssertFalse(s.contains("eval("))
        }
        let src = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/EACore/MailPage.swift").standardized, encoding: .utf8)
        XCTAssertFalse(src.contains("evaluateJavaScript("), "only callAsyncJavaScript, with arguments")
        XCTAssertFalse(src.contains("contentWorld: .page"))
        XCTAssertFalse(src.contains("uiDelegate = self"))
        XCTAssertTrue(src.contains("allowsContentJavaScript = false"))
        XCTAssertTrue(src.contains(".nonPersistent()"))
        XCTAssertTrue(src.contains("loadHTMLString(html, baseURL: nil)"))
    }
}
#endif
