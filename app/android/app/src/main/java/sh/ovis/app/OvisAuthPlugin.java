package sh.ovis.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Signing in to the account from the app (docs/account.md, "Signing in"; src/lib/account/native.ts):
 * the sign-in opens in the system browser, and the account service sends it back to
 * ovis://account/callback, which the manifest routes to MainActivity and Capacitor hands here. The
 * page finishes the sign-in itself; nothing here keeps a token. Sign in with Apple has no native
 * form on Android, so Apple takes the same browser route. The iOS twin: app/ios/App/App/OvisAuthPlugin.swift.
 */
@CapacitorPlugin(name = "OvisAuth")
public class OvisAuthPlugin extends Plugin {
    private PluginCall waiting;
    /** the state of the sign-in waiting: only a return naming it is taken */
    private String expectedState;

    private void release(PluginCall call) {
        call.setKeepAlive(false);
        getBridge().releaseCall(call);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("Sign in at an https address", "invalid_url");
            return;
        }
        String state = Uri.parse(url).getQueryParameter("state");
        if (state == null || state.isEmpty()) {
            call.reject("That sign-in names no state", "invalid_url");
            return;
        }
        // one sign-in at a time: a new one ends the one before
        if (waiting != null) {
            PluginCall replaced = waiting;
            release(replaced);
            replaced.reject("The sign-in was replaced", "cancelled");
        }
        waiting = call;
        expectedState = state;
        call.setKeepAlive(true);
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException error) {
            waiting = null;
            expectedState = null;
            release(call);
            call.reject("No browser could open the sign-in", "failed");
        }
    }

    @PluginMethod
    public void signInWithApple(PluginCall call) {
        call.reject("Sign in with Apple runs in the browser on Android", "unavailable");
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri data = intent.getData();
        if (data == null || !"ovis".equals(data.getScheme()) || !"account".equals(data.getHost()) || !"/callback".equals(data.getPath())) return;
        PluginCall call = waiting;
        if (call == null) return;
        // another app can send this address too: only this sign-in's own return, with a code or an error, ends the wait
        String state = data.getQueryParameter("state");
        boolean answered = data.getQueryParameter("code") != null || data.getQueryParameter("error") != null;
        if (expectedState == null || !expectedState.equals(state) || !answered) return;
        waiting = null;
        expectedState = null;
        JSObject result = new JSObject();
        result.put("url", data.toString());
        release(call);
        call.resolve(result);
    }
}
