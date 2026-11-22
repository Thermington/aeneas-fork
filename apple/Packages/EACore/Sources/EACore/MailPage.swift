#if os(iOS) || os(macOS)
import Foundation
import WebKit

/// A mail as sent (the hub's cleaned page, `hub/src/mail-html.ts`) in a web view where nothing of the mail runs and
/// nothing loads. Mail is hostile input, so this is the last of several walls, each enough on its own:
/// - the hub rebuilt the page from a list of allowed elements, and its Content-Security-Policy loads nothing but the
///   data: pictures in it;
/// - the page's own JavaScript is off (`allowsContentJavaScript`), whatever got through;
/// - a content rule list blocks every load but the page itself and data: pictures;
/// - the navigation delegate lets through the first load only; a tapped link (http, https or mailto, `Mail.frameLink`)
///   opens outside the app and never in the view, and nothing else navigates;
/// - the data store is a fresh one in memory, no window can open (no UI delegate), no link previews, no file access.
///
/// The screen's own script (laying the page out at the screen's width, sizing, folding the quoted history, seeing
/// whether there is any) runs in a content world of its own, never the page's, as fixed code: what it needs goes in
/// as arguments, never written into the code.
@MainActor
public final class MailPageController: NSObject, WKNavigationDelegate {
    /// The world the screen's own script runs in, apart from the page's.
    public static let world = WKContentWorld.world(name: "AeneasMailScreen")

    /// Every load is blocked but the page itself (about:blank, as `loadHTMLString` with no base gives it) and data:
    /// pictures. Defence in depth beside the page's own policy, which says the same.
    public static let rules = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^about:blank$"},"action":{"type":"ignore-previous-rules"}}]
    """

    private static var compiled: WKContentRuleList?

    /// The rule list, compiled once. Nil only when WebKit refuses it, and then no page is shown at all.
    public static func ruleList() async -> WKContentRuleList? {
        if let compiled { return compiled }
        let list = try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "AeneasMailBlockAll", encodedContentRuleList: rules)
        compiled = list
        return list
    }

    /// The setting every mail page gets.
    public static func configuration(rules: WKContentRuleList) -> WKWebViewConfiguration {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = .nonPersistent()
        c.defaultWebpagePreferences.allowsContentJavaScript = false
        c.preferences.javaScriptCanOpenWindowsAutomatically = false
        c.preferences.isElementFullscreenEnabled = false
        c.preferences.isFraudulentWebsiteWarningEnabled = false
        c.userContentController.add(rules)
        c.userContentController.addUserScript(WKUserScript(source: viewportScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        c.allowsAirPlayForMediaPlayback = false
        c.mediaTypesRequiringUserActionForPlayback = .all
        #if os(iOS)
        c.dataDetectorTypes = []
        c.allowsInlineMediaPlayback = false
        c.allowsPictureInPictureMediaPlayback = false
        #endif
        return c
    }

    /// The page laid out at the screen's width: the hub's page names no width, and a phone then lays it out 980 points
    /// wide and shrinks it, so a plain reply read in tiny type. A mail made wider than the screen (a 600 point
    /// newsletter) is laid out at its own width instead and shrunk to fit, as mail apps show it. Runs in the screen's
    /// own world, as fixed code (the width is the page's own measure, a number); ignored on the Mac.
    static let viewportScript = """
    if (document.head && !document.querySelector('meta[name="viewport"]')) {
      const m = document.createElement('meta');
      m.setAttribute('name', 'viewport');
      m.setAttribute('content', 'width=device-width, initial-scale=1');
      document.head.appendChild(m);
      const d = document.documentElement;
      const wide = Math.ceil(Math.max(d.scrollWidth, document.body ? document.body.scrollWidth : 0));
      if (wide > d.clientWidth + 1) m.setAttribute('content', 'width=' + Math.min(wide, 2000));
    }
    """

    /// The screen's script once the page is in: each link's title is the address it goes to (a mail's own title
    /// could name another place), and whether the page has quoted history with something besides it, folded then.
    static let setupScript = """
    const b = document.body;
    if (!b) return false;
    for (const a of document.querySelectorAll('a[href]')) a.setAttribute('title', a.getAttribute('href') || '');
    b.classList.add('aeneas-fold');
    const foldable = !!document.querySelector(selector) && (b.innerText.trim().length > 0 || !!b.querySelector('img'));
    b.classList.toggle('aeneas-fold', foldable && !unfold);
    return foldable;
    """

    /// Folds or unfolds the quoted history (the page's own CSS hides it while its body has `aeneas-fold`).
    static let foldScript = """
    if (document.body) document.body.classList.toggle('aeneas-fold', fold);
    return true;
    """

    /// The mail's own height, read a moment after the view was made one point tall, so a mail sized by its view
    /// (height: 100%, 110vh) cannot make the view grow each time it is measured.
    static let measureScript = """
    await new Promise((r) => setTimeout(r, 80));
    const d = document.documentElement;
    return Math.max(d ? d.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
    """

    public let webView: WKWebView
    /// Where a tapped link goes: outside the app.
    public var onOpen: (URL) -> Void
    /// The page's height, measured; at most `Mail.pageMax`.
    public var onHeight: (Double) -> Void
    /// Whether the page has quoted history to fold.
    public var onFoldable: (Bool) -> Void
    /// Makes the view one point tall while it is measured, and back after.
    public var setMeasuring: (Bool) -> Void = { _ in }

    private var firstLoadAllowed = false
    private var loaded = false
    private var unfolded = false
    private var foldable = false
    /// How many navigations were let through (one: the page itself). Read by the tests.
    public private(set) var allowedNavigations = 0

    public init(configuration: WKWebViewConfiguration, onOpen: @escaping (URL) -> Void, onHeight: @escaping (Double) -> Void = { _ in }, onFoldable: @escaping (Bool) -> Void = { _ in }) {
        #if os(macOS)
        webView = MailWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 1), configuration: configuration)
        #else
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 1), configuration: configuration)
        #endif
        self.onOpen = onOpen
        self.onHeight = onHeight
        self.onFoldable = onFoldable
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = nil
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.isInspectable = false
        #if os(iOS)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        #endif
    }

    /// Shows a page. Only the first load is let through; a second page needs a new controller.
    public func load(_ html: String) {
        guard !firstLoadAllowed else { return }
        webView.loadHTMLString(html, baseURL: nil)
    }

    /// Folds the quoted history, or shows it, and measures again.
    public func setUnfolded(_ on: Bool) {
        unfolded = on
        guard loaded else { return }
        Task {
            _ = try? await webView.callAsyncJavaScript(Self.foldScript, arguments: ["fold": foldable && !on], in: nil, contentWorld: Self.world)
            await measure()
        }
    }

    /// The page's height at one point tall, at most `Mail.pageMax`; a longer page scrolls itself.
    @discardableResult
    public func measure() async -> Double {
        guard loaded else { return 0 }
        setMeasuring(true)
        var raw = (try? await webView.callAsyncJavaScript(Self.measureScript, arguments: [:], in: nil, contentWorld: Self.world)) as? Double
        setMeasuring(false)
        #if os(iOS)
        // A wide mail shrunk to fit: its height on the screen is its own times the shrinking.
        let zoom = webView.scrollView.zoomScale
        if let r = raw, zoom > 0.05, zoom < 1 { raw = r * Double(zoom) }
        #endif
        let h = min(max(raw ?? 60, 60), Mail.pageMax)
        #if os(iOS)
        webView.scrollView.isScrollEnabled = (raw ?? 0) > Mail.pageMax
        #else
        (webView as? MailWebView)?.scrollsItself = (raw ?? 0) > Mail.pageMax
        #endif
        onHeight(h)
        return h
    }

    // MARK: WKNavigationDelegate

    public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        preferences.allowsContentJavaScript = false
        switch Self.decide(url: action.request.url, firstLoadDone: firstLoadAllowed, mainFrame: action.targetFrame?.isMainFrame ?? false, linkTapped: action.navigationType == .linkActivated) {
        case .allow:
            firstLoadAllowed = true
            allowedNavigations += 1
            decisionHandler(.allow, preferences)
        case .cancel(let open):
            decisionHandler(.cancel, preferences)
            if let open { onOpen(open) }
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        // Only the page itself is ever answered: nothing that could be downloaded or shown in its place.
        decisionHandler(response.response.url?.absoluteString == "about:blank" && response.isForMainFrame ? .allow : .cancel)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        Task {
            let f = (try? await webView.callAsyncJavaScript(Self.setupScript, arguments: ["selector": Mail.quoteSelector, "unfold": unfolded], in: nil, contentWorld: Self.world)) as? Bool
            foldable = f ?? false
            onFoldable(foldable)
            await measure()
        }
    }

    /// What happens to a navigation: the page's own first load goes through; anything after it is stopped, and a
    /// link the person tapped opens outside the app when it is http, https or mailto.
    public enum Decision: Equatable { case allow, cancel(open: URL?) }

    public static func decide(url: URL?, firstLoadDone: Bool, mainFrame: Bool, linkTapped: Bool) -> Decision {
        if !firstLoadDone, mainFrame, url?.absoluteString == "about:blank" { return .allow }
        return .cancel(open: linkTapped ? Mail.frameLink(url?.absoluteString) : nil)
    }
}

#if os(macOS)
/// The Mac's mail view: a scroll over a page that fits goes to the screen around it, and the right-click menu keeps
/// only copying and looking up (no opening in a window, no downloading a link, no reloading).
final class MailWebView: WKWebView {
    var scrollsItself = false

    override func scrollWheel(with event: NSEvent) {
        if scrollsItself { super.scrollWheel(with: event) } else { nextResponder?.scrollWheel(with: event) }
    }

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        let keep: Set<String> = ["WKMenuItemIdentifierCopy", "WKMenuItemIdentifierCopyLink", "WKMenuItemIdentifierLookUp"]
        for item in menu.items where !keep.contains(item.identifier?.rawValue ?? "") { menu.removeItem(item) }
        super.willOpenMenu(menu, with: event)
    }
}
#endif
#endif
