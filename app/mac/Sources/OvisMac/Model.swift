import AppKit
import Foundation

/// Ends a request at its redirect: the redirect's own response is the answer.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct Status: Equatable {
    var running: Bool
    var origin: URL?
    /// The HTTPS address Tailscale serves the app at, which the phone opens.
    var phoneURL: URL?
    /// "missing", "stopped" or "running", as /api/access reports Tailscale.
    var tailscale: String?
}

@MainActor
final class Model: ObservableObject {
    enum Phase: Equatable {
        case checking
        case notInstalled
        case working(String)
        case failed(String)
        case installed
    }

    @Published var phase: Phase = .checking
    @Published var log: [String] = []
    @Published var status: Status?
    /// The Ovis page the main window shows: the running server's address, nil while it is not running.
    @Published private(set) var webOrigin: URL?
    /// Bumped to load the page again: View > Reload, or the server answering again after it was gone.
    @Published private(set) var reloads = 0
    /// An Install from this app is done: the phone's QR code opens next to the page.
    @Published var phoneSetupRequested = false
    /// The main window's page, for Open in Browser.
    weak var page: WebPageController?
    /// The page did not load: it loads again once the server answers. A page that did load reconnects
    /// by itself, as it does in a browser, and keeps what the user had open in it.
    private var pageFailedToLoad = false
    /// Bumped as Install, Restart, Make the phone address or Remove starts: a check that began before it
    /// must not put its result over theirs.
    private var work = 0
    private var pluginRoot: String?
    /// The id the plugin is installed under: an install of an older release keeps the old one.
    private var pluginID = Ovis.pluginID
    /// What Try again repeats: a Restart that timed out restarts again rather than reinstalling.
    private var retryRestarts = false

    var logText: String { log.joined(separator: "\n") }

    /// Install, Restart or Remove is under way, and waits for the server itself.
    var busy: Bool {
        if case .working = phase { return true }
        return false
    }

    func refresh() async {
        let started = work
        let plugin = FileManager.default.isExecutableFile(atPath: Paths.herdr) ? await findPlugin() : nil
        guard work == started else { return }
        guard let plugin else {
            pluginRoot = nil
            status = nil
            webOrigin = nil
            phase = .notInstalled
            return
        }
        pluginID = plugin.id
        pluginRoot = plugin.root
        let status = await readStatus(root: plugin.root)
        guard work == started else { return }
        self.status = status
        let origin = status.running ? status.origin : nil
        if origin != webOrigin {
            // a page at a new address loads by itself
            webOrigin = origin
            pageFailedToLoad = false
        }
        phase = .installed
    }

    /// Keeps the main window on a live page for as long as the app runs. A running page reconnects by
    /// itself to a server that comes back, and tells the user itself when the server it meets was
    /// updated; a page that did not load, or whose code never started, loads again once the server
    /// answers. Every fifth miss (about 15 s) reads the status again: the server may be on another port
    /// now, or stopped, and then the window shows Start. A server started outside the app (a terminal,
    /// herdr's own start) is picked up the same way.
    func monitor() async {
        var misses = 0
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            // Install, Restart and Remove wait for the server themselves, and a failure stays on screen
            guard phase == .installed || phase == .notInstalled else {
                misses = 0
                continue
            }
            let started = work
            var up = false
            if let origin = status?.origin { up = await answers(origin) }
            guard work == started else { continue }
            if up {
                let wasGone = misses >= 1
                misses = 0
                if webOrigin == nil {
                    await refresh()
                } else if pageFailedToLoad {
                    pageFailedToLoad = false
                    reloads += 1
                } else if wasGone {
                    page?.reloadIfNotStarted()
                }
                continue
            }
            misses += 1
            if misses % 5 == 0 { await refresh() }
        }
    }

    func pageFailed() {
        pageFailedToLoad = true
    }

    func pageLoaded() {
        pageFailedToLoad = false
    }

    func reload() {
        reloads += 1
    }

    /// The page as it is now (a pane's address), or the server's own address.
    func openInBrowser() {
        if let url = page?.webView.url ?? webOrigin ?? status?.origin { open(url) }
    }

    func retry() async {
        if retryRestarts { await restart() } else { await install() }
    }

    func install() async {
        work += 1
        retryRestarts = false
        log = []
        phase = .working(L("Downloading the installer…", "설치 프로그램을 받는 중…"))
        let script: URL
        do {
            let (data, response) = try await URLSession.shared.data(from: Ovis.installScript)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            script = FileManager.default.temporaryDirectory.appendingPathComponent("ovis-install-\(UUID().uuidString).sh")
            try data.write(to: script)
        } catch {
            fail(L("Could not download the installer from ovis.sh. Check the internet connection.", "ovis.sh에서 설치 프로그램을 받지 못했습니다. 인터넷 연결을 확인해 주세요."), detail: error.localizedDescription)
            return
        }
        defer { try? FileManager.default.removeItem(at: script) }
        phase = .working(L("Installing herdr, Bun, Node and the Ovis server…", "herdr, Bun, Node, Ovis 서버를 설치하는 중…"))
        let result = await run("/bin/sh", [script.path], env: ["OVIS_NO_OPEN": "1"], onLine: appendLine)
        guard result.status == 0 else {
            fail(L("The installer stopped with an error.", "설치 중 오류가 났습니다."))
            return
        }
        phase = .working(L("Starting herdr…", "herdr를 시작하는 중…"))
        do {
            try await LaunchAgent.install()
        } catch {
            fail(L("Could not set herdr to start at login.", "로그인할 때 herdr가 켜지도록 설정하지 못했습니다."), detail: error.localizedDescription)
            return
        }
        await waitUntilRunning()
        if webOrigin != nil { phoneSetupRequested = true }
    }

    func restart() async {
        work += 1
        retryRestarts = true
        log = []
        phase = .working(L("Restarting…", "다시 시작하는 중…"))
        if await herdrRunning(), let root = pluginRoot {
            // `herdr plugin action invoke` only queues the action, so a start invoked right after a stop
            // finds the old server still up and fails: run them here and wait for each, with the locale
            // the login item gives herdr. The output is in the log: a failure only names which one stopped.
            guard await run(Paths.bun, ["\(root)/scripts/plugin.ts", "stop"], env: ["LC_CTYPE": "UTF-8"], timeout: 60, onLine: appendLine).status == 0 else {
                fail(L("Could not stop the Ovis server.", "Ovis 서버를 멈추지 못했습니다."))
                return
            }
            guard await run(Paths.bun, ["\(root)/scripts/plugin.ts", "start"], env: ["LC_CTYPE": "UTF-8"], timeout: 60, onLine: appendLine).status == 0 else {
                fail(L("Could not start the Ovis server.", "Ovis 서버를 시작하지 못했습니다."))
                return
            }
        } else if !(await LaunchAgent.start()) {
            // herdr installed from a terminal has no login item to start: make it, which starts herdr
            do {
                try await LaunchAgent.install()
            } catch {
                fail(L("Could not start herdr.", "herdr를 시작하지 못했습니다."), detail: error.localizedDescription)
                return
            }
        }
        await waitUntilRunning()
    }

    /// The installer's phone step: `tailscale serve` for this app, when Tailscale runs here.
    func makePhoneAddress() async {
        guard let root = pluginRoot else { return }
        work += 1
        log = []
        phase = .working(L("Making the phone address…", "휴대폰 주소를 만드는 중…"))
        _ = await run(Paths.bun, ["\(root)/scripts/plugin.ts", "phone"], onLine: appendLine)
        await refresh()
    }

    /// Takes the Ovis server off this Mac, as the guide's Uninstall does. herdr, Bun and Node stay, and
    /// herdr keeps running: stopping it would end every agent in it.
    func uninstall() async {
        work += 1
        log = []
        phase = .working(L("Removing…", "제거하는 중…"))
        let phoneURL = status?.phoneURL
        // the stop has to end before the uninstall removes the plugin's files: run it here, not as a queued action
        if let root = pluginRoot {
            _ = await run(Paths.bun, ["\(root)/scripts/plugin.ts", "stop"], env: ["LC_CTYPE": "UTF-8"], timeout: 60, onLine: appendLine)
        }
        _ = await run(Paths.herdr, ["plugin", "uninstall", pluginID], onLine: appendLine)
        if let phoneURL, let tailscale = Paths.tailscale {
            _ = await run(tailscale, ["serve", "--https=\(phoneURL.port ?? 443)", "off"], onLine: appendLine)
        }
        await LaunchAgent.remove()
        await refresh()
    }

    func open(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    func copyLog() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(logText, forType: .string)
    }

    private func fail(_ message: String, detail: String? = nil) {
        if let detail { log.append(detail) }
        phase = .failed(message)
    }

    /// Called on the pipe's thread for each line a child prints; the log is appended on the main thread, in order.
    private nonisolated var appendLine: @Sendable (String) -> Void {
        { [weak self] line in
            // a QR code drawn in block characters means nothing in a log
            guard !line.isEmpty, line.contains(where: { !"█▀▄ ".contains($0) }) else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.log.append(line) }
            }
        }
    }

    /// The plugin's id and root, under its id or, for an install of an older release, the old one.
    private func findPlugin() async -> (id: String, root: String)? {
        let result = await run(Paths.herdr, ["plugin", "list", "--json"], keepStderr: false, timeout: 10)
        guard result.status == 0,
              let json = try? JSONSerialization.jsonObject(with: Data(result.output.utf8)) as? [String: Any],
              let plugins = (json["result"] as? [String: Any])?["plugins"] as? [[String: Any]]
        else { return nil }
        for id in [Ovis.pluginID, Ovis.legacyPluginID] {
            if let root = plugins.first(where: { $0["plugin_id"] as? String == id })?["plugin_root"] as? String {
                return (id, root)
            }
        }
        return nil
    }

    /// `plugin.ts status` knows the port the plugin settled on: "running http://127.0.0.1:7317 (pid 1)" or "down …".
    private func readStatus(root: String) async -> Status {
        let result = await run(Paths.bun, ["\(root)/scripts/plugin.ts", "status"], keepStderr: false, timeout: 10)
        let words = (result.output.split(separator: "\n").first ?? "").split(separator: " ")
        var status = Status(running: words.first == "running", origin: words.count > 1 ? URL(string: String(words[1])) : nil)
        guard status.running, let origin = status.origin else { return status }
        var request = URLRequest(url: origin.appendingPathComponent("api/access"))
        request.timeoutInterval = 5
        if let (data, response) = try? await URLSession.shared.data(for: request),
           (response as? HTTPURLResponse)?.statusCode == 200,
           let access = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let tailscale = access["tailscale"] as? [String: Any] {
            status.tailscale = tailscale["state"] as? String
            status.phoneURL = (tailscale["serving_url"] as? String).flatMap(URL.init(string:))
        }
        return status
    }

    /// The server's health check that leaves herdr alone (`scope=bridge`); it answers without a sign-in.
    /// Only Ovis's own answer counts, as in `scripts/plugin.ts`: another program can take a port Ovis
    /// left, and its 200 would hide the server's new address. A redirect is not followed: one to the new
    /// address would hide it the same way.
    private func answers(_ origin: URL) async -> Bool {
        guard let url = URL(string: "api/health?scope=bridge", relativeTo: origin)?.absoluteURL else { return false }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        guard let (data, response) = try? await URLSession.shared.data(for: request, delegate: NoRedirects()),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return body["ok"] as? Bool == true && body["bridge_protocol"] is Int
    }

    private func herdrRunning() async -> Bool {
        let result = await run(Paths.herdr, ["status", "server", "--json"], keepStderr: false, timeout: 10)
        return result.output.contains("\"running\":true")
    }

    /// herdr starts the app from its startup hook; give it up to two minutes, checking every two seconds,
    /// then show where it stopped instead of the spinner or the Install button.
    private func waitUntilRunning() async {
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            if let plugin = await findPlugin(), await readStatus(root: plugin.root).running {
                await refresh()
                return
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
        // herdr's own output from the login item: what it printed while it started, or failed to
        let logTail = (try? String(contentsOfFile: "\(Paths.logDir)/herdr-server.log", encoding: .utf8))?
            .split(separator: "\n").suffix(10).joined(separator: "\n")
        if await findPlugin() == nil {
            fail(L("herdr does not list the Ovis plugin. Try again, or copy the log and get help.",
                   "herdr에 Ovis 플러그인이 보이지 않습니다. 다시 시도하거나, 오류 내용을 복사해 도움을 받으세요."), detail: logTail)
        } else {
            fail(L("The Ovis server did not start within two minutes. Try again, or copy the log and get help.",
                   "Ovis 서버가 2분 안에 시작되지 않았습니다. 다시 시도하거나, 오류 내용을 복사해 도움을 받으세요."),
                 detail: logTail)
        }
    }
}

/// `herdr server` as a login item of this user, so herdr, and the app with it, is up without a terminal.
enum LaunchAgent {
    private static var domain: String { "gui/\(getuid())" }
    private static var service: String { "\(domain)/\(Ovis.agentLabel)" }

    static func install() async throws {
        let manager = FileManager.default
        try manager.createDirectory(atPath: Paths.logDir, withIntermediateDirectories: true)
        try manager.createDirectory(atPath: (Paths.launchAgent as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "Label": Ovis.agentLabel,
            "ProgramArguments": [Paths.herdr, "server"],
            "RunAtLoad": true,
            // launchd starts herdr with no locale, and its panes' shells inherit that: without a
            // character set they read Korean and emoji as bytes
            "EnvironmentVariables": ["PATH": Paths.path, "HOME": Paths.home, "LC_CTYPE": "UTF-8"],
            // launchd kills the job's whole process group when herdr exits; a server herdr hands its
            // sessions to (an update) would go with it, and every agent in it
            "AbandonProcessGroup": true,
            "StandardOutPath": "\(Paths.logDir)/herdr-server.log",
            "StandardErrorPath": "\(Paths.logDir)/herdr-server.log",
            "ProcessType": "Interactive",
        ]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: URL(fileURLWithPath: Paths.launchAgent))
        _ = await run("/bin/launchctl", ["enable", service])
        // a loaded agent may be running herdr with the user's agents in it: never boot it out to reload
        if await loaded() { _ = await start(); return }
        let result = await run("/bin/launchctl", ["bootstrap", domain, Paths.launchAgent])
        guard result.status == 0 else { throw NSError(domain: "Ovis", code: Int(result.status), userInfo: [NSLocalizedDescriptionKey: result.output]) }
    }

    /// Starts herdr when it is not running; a running herdr is left as it is. False when launchd has
    /// no such agent (herdr set up from a terminal, or the plist removed).
    @discardableResult
    static func start() async -> Bool {
        await run("/bin/launchctl", ["kickstart", service]).status == 0
    }

    /// Stops it from starting at the next login without stopping the herdr that runs now.
    static func remove() async {
        _ = await run("/bin/launchctl", ["disable", service])
        try? FileManager.default.removeItem(atPath: Paths.launchAgent)
    }

    private static func loaded() async -> Bool {
        await run("/bin/launchctl", ["print", service], keepStderr: false).status == 0
    }
}
