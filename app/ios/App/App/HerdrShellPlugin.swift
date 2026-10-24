import Foundation
import Capacitor

/// What the app's own pages (app/web) and the client's "Change PC" (src/lib/nativeApp.ts) ask
/// of the app: open a PC, forget one, go back to the connect screen.
@objc(HerdrShellPlugin)
public class HerdrShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HerdrShellPlugin"
    public let jsName = "HerdrShell"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retry", returnType: CAPPluginReturnPromise)
    ]

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve([
            "saved": PCStore.saved,
            "current": PCStore.current ?? "",
            "last": PCStore.last ?? "",
            "failure": PCStore.failure ?? ""
        ])
    }

    /// `url`: an http or https address; the address itself (a pairing link's code included) is the
    /// first page. Its origin joins the saved PCs once a page of it has loaded
    /// (NavigationFailureProxy), so an address that never answered is not kept.
    @objc func open(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text), let origin = PCStore.origin(of: url) else {
            call.reject("That is not an http or https address.")
            return
        }
        PCStore.current = origin
        PCStore.last = origin
        PCStore.pendingStart = text
        PCStore.failure = nil
        PCStore.redirects = 0
        call.resolve()
        DispatchQueue.main.async { HerdrBridgeViewController.reopen() }
    }

    @objc func forget(_ call: CAPPluginCall) {
        if let origin = call.getString("url") { PCStore.forget(origin) }
        call.resolve()
    }

    /// Back to the connect screen; the PC stays in the list.
    @objc func disconnect(_ call: CAPPluginCall) {
        PCStore.current = nil
        call.resolve()
        DispatchQueue.main.async { HerdrBridgeViewController.reopen() }
    }

    /// Opens the current PC again from its first page.
    @objc func retry(_ call: CAPPluginCall) {
        PCStore.failure = nil
        PCStore.redirects = 0
        call.resolve()
        DispatchQueue.main.async { HerdrBridgeViewController.reopen() }
    }
}
