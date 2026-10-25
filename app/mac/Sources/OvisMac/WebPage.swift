import AppKit
import Combine
import SwiftUI
import WebKit

/// The Ovis page in the main window, under a cover while it loads or while the server does not answer.
struct WebPage: View {
    @StateObject private var page: WebPageController

    init(origin: URL, model: Model) {
        _page = StateObject(wrappedValue: WebPageController(origin: origin, model: model))
    }

    var body: some View {
        ZStack {
            WebViewHost(webView: page.webView)
            switch page.state {
            case .shown:
                EmptyView()
            case .loading:
                cover { ProgressView() }
            case let .failed(reason):
                cover {
                    VStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text(L("Waiting for Ovis to answer…", "Ovis의 응답을 기다리는 중…")).font(.headline)
                        Text(reason).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// Hides the web view's empty white frame, which a dark window would flash.
    private func cover<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content().frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct WebViewHost: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

/// Typing goes to the page from the start, as it does in a browser tab.
final class OvisWebView: WKWebView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.makeFirstResponder(self)
    }
}

/// One Ovis page: the main window's, or a window the page opened (window.open, a target="_blank" link).
/// The Ovis server's own pages stay in the app; any other address goes to the default browser.
@MainActor
final class WebPageController: NSObject, ObservableObject {
    enum State: Equatable {
        case loading
        case shown
        case failed(String)
    }

    @Published private(set) var state: State = .loading
    let webView: WKWebView
    private let origin: URL
    private weak var model: Model?
    /// A window the page opened, rather than the main window's page.
    private let isPopup: Bool
    /// A popup's own window, made once its first Ovis page is committed.
    private var window: NSWindow?
    /// The popup's window was closed. A minimized or hidden one is not visible either, and is still open.
    private var closed = false
    /// Every popup, until its window closes or, for one that never got a window, until it is done: they
    /// outlive the page that opened them, which a restart or a new address replaces.
    private static var popups: [WebPageController] = []
    /// Download destinations handed out and not finished yet, so two downloads of one name get two files.
    private static var reserved: Set<String> = []
    private var destinations: [ObjectIdentifier: URL] = [:]
    private var reloads: AnyCancellable?

    /// A popup gets the configuration WebKit hands over for it; the main window's page makes its own.
    init(origin: URL, model: Model, popupConfiguration: WKWebViewConfiguration? = nil) {
        self.origin = origin
        self.model = model
        isPopup = popupConfiguration != nil
        webView = OvisWebView(frame: .zero, configuration: popupConfiguration ?? Self.configuration())
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = .windowBackgroundColor
        // a popup is loaded by WebKit, with the request that opened it
        guard !isPopup else { return }
        model.page = self
        reloads = model.$reloads.dropFirst().sink { [weak self] _ in self?.reload() }
        webView.load(URLRequest(url: origin))
    }

    static func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        // the page's sign-in cookie and its drafts stay across launches
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = userAgentSuffix
        return configuration
    }

    /// Safari's own end of the user agent, then this app's name. A web view sends neither by itself, and
    /// the terminal's Korean input goes by "Safari" (xterm.js's Hangul handling, patches/), as do the
    /// client's device names; "OvisMac" tells the client it runs in this app (src/lib/nativeApp.ts).
    /// The web view is the system's WebKit, the one the installed Safari uses, so it reports that version.
    static let userAgentSuffix: String = {
        let safari = Bundle(path: "/Applications/Safari.app")?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let version = safari.map { $0.split(separator: ".").prefix(2).joined(separator: ".") } ?? "17.0"
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0"
        return "Version/\(version) Safari/605.1.15 OvisMac/\(app)"
    }()

    /// After the server was gone: a page whose code never started (its HTML loaded, its scripts did not)
    /// has nothing that reconnects, so it loads again. A running page keeps what is open in it.
    func reloadIfNotStarted() {
        webView.evaluateJavaScript("document.getElementById('root')?.childElementCount ?? 0") { [weak self] result, _ in
            if (result as? Int ?? 0) == 0 { self?.reload() }
        }
    }

    /// Loads the page again where it is, or from the start when it is not on an Ovis page.
    func reload() {
        if state != .shown { state = .loading }
        let current = webView.url.flatMap { isOvis($0) ? $0 : nil }
        webView.load(URLRequest(url: current ?? origin))
    }

    private func isOvis(_ url: URL) -> Bool {
        url.scheme?.lowercased() == origin.scheme?.lowercased() && url.host?.lowercased() == origin.host?.lowercased()
            && Self.port(url.port, scheme: url.scheme) == Self.port(origin.port, scheme: origin.scheme)
    }

    private func isOvis(_ origin: WKSecurityOrigin) -> Bool {
        origin.protocol.lowercased() == self.origin.scheme?.lowercased() && origin.host.lowercased() == self.origin.host?.lowercased()
            && Self.port(origin.port, scheme: origin.protocol) == Self.port(self.origin.port, scheme: self.origin.scheme)
    }

    /// The port an address means: none (a URL) or 0 (WebKit's origin) is the scheme's own, which an
    /// address may also spell out (`http://host:80`).
    private static func port(_ port: Int?, scheme: String?) -> Int {
        if let port, port != 0 { return port }
        return scheme?.lowercased() == "https" ? 443 : 80
    }

    /// Another site or a mail link opens where the system opens it. Another app's link (a site in a web
    /// panel can make any) asks first, as Safari does. A file (one dropped where the page takes none,
    /// which would replace the page) and the page's own data stay where they are.
    private func openElsewhere(_ url: URL) {
        guard let scheme = url.scheme?.lowercased() else { return }
        if ["http", "https", "mailto"].contains(scheme) {
            NSWorkspace.shared.open(url)
            return
        }
        guard !["file", "data", "blob", "javascript", "about"].contains(scheme),
              let app = NSWorkspace.shared.urlForApplication(toOpen: url) else { return }
        let name = FileManager.default.displayName(atPath: app.path)
        let alert = NSAlert()
        alert.messageText = L("Open this link in “\(name)”?", "이 링크를 “\(name)”에서 열까요?")
        alert.informativeText = String(url.absoluteString.prefix(300))
        alert.addButton(withTitle: L("Open", "열기"))
        alert.addButton(withTitle: L("Cancel", "취소"))
        guard let window = webView.window else {
            if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(url) }
            return
        }
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { NSWorkspace.shared.open(url) }
        }
    }

    private func failed(_ error: Error) {
        let error = error as NSError
        // a load stopped on purpose: a newer one, a link handed to the browser, a download
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        // WebKit's "frame load interrupted" (102) and "plug-in handled load" (204)
        if error.domain == "WebKitErrorDomain" && (error.code == 102 || error.code == 204) { return }
        guard !isPopup else {
            // a new tab that could not load has no window to show its error in
            if window == nil { closePopup() }
            return
        }
        state = .failed(error.localizedDescription)
        model?.pageFailed()
    }

    private func showWindow() {
        guard window == nil else { return }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 720), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Ovis"
        window.contentView = webView
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    /// Ends a popup: its window closes, or one that never got a window lets go once its downloads end.
    /// Later, not inside the WebKit callback that asked for it.
    private func closePopup() {
        DispatchQueue.main.async { [self] in
            if let window, !closed {
                // its windowWillClose comes back here
                window.close()
            } else if destinations.isEmpty {
                Self.popups.removeAll { $0 === self }
            }
        }
    }
}

extension WebPageController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            // only an Ovis page saves into Downloads by itself; a site's (a web panel's) download goes to
            // the browser, which asks as it does for any site
            if let source = navigationAction.sourceFrame as WKFrameInfo?, isOvis(source.securityOrigin) {
                decisionHandler(.download)
            } else {
                decisionHandler(.cancel)
                navigationAction.request.url.map(openElsewhere)
            }
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        // a frame inside the page (a web panel) may show any site; only the page itself is kept to Ovis
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(url.isFileURL ? .cancel : .allow)
            return
        }
        if isOvis(url) || url.absoluteString == "about:blank" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        openElsewhere(url)
        // window.open() then an address elsewhere (a sign-in page): the browser has it, the popup is not needed
        if isPopup && window == nil { closePopup() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        guard disposition.lowercased().hasPrefix("attachment") || !navigationResponse.canShowMIMEType else {
            decisionHandler(.allow)
            return
        }
        // a page (main frame) is always Ovis's own; a file a frame inside it shows is saved only when it
        // comes from the Ovis server, and a site's goes to the browser
        let url = navigationResponse.response.url
        if navigationResponse.isForMainFrame || url.map(isOvis) == true {
            decisionHandler(.download)
        } else {
            decisionHandler(.cancel)
            url.map(openElsewhere)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// A popup's window opens once an Ovis page is really coming: a new tab that turns into a download
    /// leaves no empty window behind.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if isPopup, let url = webView.url, isOvis(url) { showWindow() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        state = .shown
        if let window, let title = webView.title, !title.isEmpty { window.title = title }
        if !isPopup { model?.pageLoaded() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
    }
}

extension WebPageController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let url = navigationAction.request.url
        if let url, !url.absoluteString.isEmpty, url.absoluteString != "about:blank", !isOvis(url) {
            openElsewhere(url)
            return nil
        }
        // only the Ovis page itself opens app windows: a site in a web panel could otherwise fill a blank
        // one by script, and it would stay hidden
        let source = navigationAction.sourceFrame
        guard let model, source.isMainFrame, isOvis(source.securityOrigin) else { return nil }
        // an empty one waits for the address the page gives it
        let popup = WebPageController(origin: origin, model: model, popupConfiguration: configuration)
        Self.popups.append(popup)
        return popup.webView
    }

    func webViewDidClose(_ webView: WKWebView) {
        if isPopup { closePopup() }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window = webView.window else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
            return
        }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /// Dictation in the Ovis page: macOS asks once whether the app may use the microphone
    /// (NSMicrophoneUsageDescription). Anything else, such as a site in a web panel, is asked about.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(frame.isMainFrame && isOvis(origin) && type == .microphone ? .grant : .prompt)
    }
}

extension WebPageController: WKDownloadDelegate {
    /// Into Downloads, as a browser saves, under a free name.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = (suggestedFilename as NSString).lastPathComponent
        let destination = Self.freeName(name.isEmpty ? "download" : name, in: folder)
        Self.reserved.insert(destination.path)
        destinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = ended(download) else { return }
        // the Dock's Downloads stack bounces, as it does for a browser's download
        DistributedNotificationCenter.default().post(name: Notification.Name("com.apple.DownloadFileFinished"), object: file.path)
    }

    /// A download that goes on to another site is that site's: the browser has it, as for a site's own.
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        guard let url = request.url, !isOvis(url) else {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        openElsewhere(url)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        _ = ended(download)
        // a redirect handed to the browser cancels the download: nothing went wrong
        if (error as NSError).domain == NSURLErrorDomain && (error as NSError).code == NSURLErrorCancelled { return }
        // a popup whose window was closed shows it in the main window
        guard let window = (closed ? nil : webView.window) ?? model?.page?.webView.window else { return }
        NSAlert(error: error).beginSheetModal(for: window)
    }

    /// Lets go of a download's file name, and of a popup that only existed for the download.
    private func ended(_ download: WKDownload) -> URL? {
        let file = destinations.removeValue(forKey: ObjectIdentifier(download))
        if let file { Self.reserved.remove(file.path) }
        if isPopup && (window == nil || closed) { closePopup() }
        return file
    }

    /// "name.ext", then "name 2.ext", "name 3.ext"…
    static func freeName(_ name: String, in folder: URL) -> URL {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var candidate = folder.appendingPathComponent(name)
        var number = 2
        while FileManager.default.fileExists(atPath: candidate.path) || reserved.contains(candidate.path) {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(number)" : "\(base) \(number).\(ext)")
            number += 1
        }
        return candidate
    }
}

extension WebPageController: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        // a download still running keeps its popup until it ends
        closed = true
        closePopup()
    }
}
