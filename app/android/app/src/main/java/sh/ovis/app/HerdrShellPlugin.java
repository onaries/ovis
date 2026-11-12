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
    /** Opens still being checked: one cancelled, replaced or outlived by its activity does nothing when its check comes back. */
    private final PCStore.Openings openings = new PCStore.Openings();
    @PluginMethod
    public void getState(PluginCall call) {
        JSObject state = new JSObject();
        state.put("saved", new JSArray(PCStore.saved(getContext())));
        state.put("names", PCStore.names(getContext()));
        String current = PCStore.current(getContext());
        String last = PCStore.last(getContext());
        state.put("name", last == null ? "" : PCStore.names(getContext()).optString(last, ""));
        state.put("current", current == null ? "" : current);
        state.put("last", last == null ? "" : last);
        state.put("failure", PCStore.failure == null ? "" : PCStore.failure);
        state.put("kind", PCStore.failureKind == null ? "" : PCStore.failureKind);
        call.resolve(state);
    }

    /**
     * url: an http or https address, the first page (a pairing link's code or a relay pairing offer's
     * fragment included). Its origin is remembered, or `scope` for a PC opened through the Ovis relay
     * (`https://app.ovis.sh/s/<server_id>/`, labelled `name`). With `check`, an address typed, scanned
     * or picked from the list is first asked whether it is Ovis (PCStore.check), for at most
     * ANSWER_SECONDS: when it is not, or does not answer, the call is refused with the check's kind as
     * its code and its detail as its message, and the connect screen stays.
     */
    @PluginMethod
    public void open(PluginCall call) {
        String text = call.getString("url");
        String key = text == null ? null : PCStore.origin(text);
        if (key == null) {
            call.reject("That is not an http or https address.");
            return;
        }
        String scope = call.getString("scope");
        if (scope != null) {
            key = PCStore.scopeKey(scope, text);
            if (key == null) {
                call.reject("That relay link is not within its PC's scope.");
                return;
            }
        }
        String name = call.getString("name");
        int mine = openings.start();
        if (!Boolean.TRUE.equals(call.getBoolean("check", false))) {
            openChecked(call, key, text, name, mine, 0);
            return;
        }
        String pc = key;
        String cookies = android.webkit.CookieManager.getInstance().getCookie(PCStore.origin(text));
        // one limit from Open to the PC's first page: the cover gets what the check left (PCStore.answerBy)
        long answerBy = android.os.SystemClock.elapsedRealtime() + PCStore.ANSWER_SECONDS * 1000L;
        new Thread(() -> {
            PCStore.Check found = PCStore.check(text, cookies, PCStore.ANSWER_SECONDS * 1000L);
            if (found.opens()) openChecked(call, pc, text, name, mine, answerBy);
            else call.reject(found.detail == null ? found.kind : found.detail, found.kind);
        }, "ovis-check").start();
    }

    /**
     * Opens the PC `key`, unless another open or a cancelOpen came after this one (`mine`), with the
     * first page due by `answerBy` (0: ANSWER_SECONDS from the new activity). Any thread.
     */
    private void openChecked(PluginCall call, String key, String text, String name, int mine, long answerBy) {
        synchronized (openings) {
            android.app.Activity activity = getActivity();
            if (!openings.current(mine) || activity == null || activity.isFinishing() || activity.isDestroyed()) {
                call.reject("Cancelled", "cancelled");
                return;
            }
            if (name != null && !name.isEmpty()) PCStore.setName(getContext(), key, name.length() > 64 ? name.substring(0, 64) : name);
            PCStore.open(getContext(), key, text);
            PCStore.fail(null, null);
            PCStore.redirects = 0;
            PCStore.answerBy = answerBy;
        }
        call.resolve();
        // a Cancel that lands before the switch still wins: the connect screen stays, opening nothing at the next start
        android.app.Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            synchronized (openings) {
                if (!openings.current(mine)) {
                    PCStore.setCurrent(getContext(), null);
                    PCStore.answerBy = 0;
                    return;
                }
            }
            ((MainActivity) activity).reopen();
        });
    }

    /** The connect screen's Cancel: an open still being checked does not go on. */
    @PluginMethod
    public void cancelOpen(PluginCall call) {
        openings.cancel();
        call.resolve();
    }

    /** The connect screen is gone (Back, or the system ended it): an open still being checked does not start the app again. */
    @Override
    protected void handleOnDestroy() {
        openings.cancel();
        super.handleOnDestroy();
    }

    /**
     * The app link the app was opened with (MainActivity), once, or "": the connect screen opens it
     * as it would a scanned QR code. A PC's page has the bridge too: an activity showing a PC (its
     * server URL is the PC's) never hands the link out, as it may hold another PC's pairing code.
     */
    @PluginMethod
    public void takeLink(PluginCall call) {
        String link = null;
        if (getBridge().getServerUrl() == null) {
            link = PCStore.link;
            PCStore.link = null;
        }
        JSObject result = new JSObject();
        result.put("url", link == null ? "" : link);
        call.resolve(result);
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String key = call.getString("url");
        if (key != null) PCStore.forget(getContext(), key);
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
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        call.resolve();
        reopen();
    }

    private void reopen() {
        getActivity().runOnUiThread(() -> ((MainActivity) getActivity()).reopen());
    }
}
