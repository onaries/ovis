package sh.ovis.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * What the app's own pages (app/web) and the client's Change PC (src/lib/nativeApp.ts) ask of the
 * app: open a PC, forget one, go back to the connect screen. The iOS twin is HerdrShellPlugin.swift.
 */
@CapacitorPlugin(name = "HerdrShell")
public class HerdrShellPlugin extends Plugin {
    @PluginMethod
    public void getState(PluginCall call) {
        JSObject state = new JSObject();
        state.put("saved", new JSArray(PCStore.saved(getContext())));
        String current = PCStore.current(getContext());
        String last = PCStore.last(getContext());
        state.put("current", current == null ? "" : current);
        state.put("last", last == null ? "" : last);
        state.put("failure", PCStore.failure == null ? "" : PCStore.failure);
        call.resolve(state);
    }

    /** url: an http or https address; its origin is remembered, and the address itself (a pairing link's code included) is the first page. */
    @PluginMethod
    public void open(PluginCall call) {
        String text = call.getString("url");
        String origin = text == null ? null : PCStore.origin(text);
        if (origin == null) {
            call.reject("That is not an http or https address.");
            return;
        }
        PCStore.open(getContext(), origin, text);
        PCStore.failure = null;
        PCStore.redirects = 0;
        call.resolve();
        reopen();
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String origin = call.getString("url");
        if (origin != null) PCStore.forget(getContext(), origin);
        call.resolve();
    }

    /** Back to the connect screen; the PC stays in the list. */
    @PluginMethod
    public void disconnect(PluginCall call) {
        PCStore.setCurrent(getContext(), null);
        call.resolve();
        reopen();
    }

    /** Opens the current PC again from its first page. */
    @PluginMethod
    public void retry(PluginCall call) {
        PCStore.failure = null;
        PCStore.redirects = 0;
        call.resolve();
        reopen();
    }

    private void reopen() {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).reopen());
    }
}
