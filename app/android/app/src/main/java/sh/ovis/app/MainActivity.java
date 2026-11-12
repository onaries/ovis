package sh.ovis.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.core.graphics.ColorUtils;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;
import com.getcapacitor.JSObject;
import com.getcapacitor.WebViewListener;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Capacitor's activity with the chosen PC as the WebView's first page, as HerdrBridgeViewController
 * does on iOS: opening or leaving a PC starts the activity again (reopen), so the next page is a
 * first load too.
 */
public class MainActivity extends BridgeActivity {
    /**
     * Sends the page's theme-color (the client keeps it at its top bar's color, the app's own pages
     * at theirs) to OvisBars, now and whenever it changes, so the system bars match the page.
     */
    private static final String BAR_COLOR_SCRIPT =
        "(() => {" +
        "  if (window !== window.top) return;" +
        "  const apply = () => {" +
        "  const meta = document.querySelector('meta[name=\"theme-color\"]');" +
        "  if (!meta) return;" +
        "  const send = () => { if (meta.content && window.OvisBars) OvisBars.postMessage(meta.content); };" +
        "  new MutationObserver(send).observe(meta, { attributes: true, attributeFilter: ['content'] });" +
        "  send();" +
        "  };" +
        "  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', apply, { once: true });" +
        "  else apply();" +
        "})();";

    /** Whether the page itself (not a picture or a frame in it) failed since it started. */
    private boolean pageFailed;

    /** Whether a page has shown in this activity: from then on a user could have followed a link from it. */
    private boolean pageShown;

    /**
     * Whether the address being opened led to something in front of the PC, such as a sign-in page:
     * until a page of the PC loads, main-frame navigations (the sign-in's pages, its identity
     * provider's, the way back to the PC) stay in the WebView, so the sign-in's cookie lands in the
     * WebView's store, which onPause flushes, rather than in the browser's.
     */
    private volatile boolean signingIn;

    /** The origin the sign-in is on, so each of its steps is judged against the one before (PCStore.refusedHop). */
    private volatile String signInAt;

    /** The page's theme-color the system bars took, put back after a configuration change. */
    private Integer barColor;

    /** Covers the WebView, blank until the PC answers: which PC is opening, and Change PC (showOpening). */
    private View openingView;

    /** Gives up on a PC that has not answered in ANSWER_SECONDS, where Chromium alone waits about two minutes. */
    private final Handler answerTimer = new Handler(Looper.getMainLooper());

    /** Whether the app gave up on the first page: the load it dropped may still report its end. */
    private boolean gaveUp;

    /** Whether a page of the PC has been checked for being Ovis (PCStore.check) in this activity. */
    private boolean checked;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HerdrShellPlugin.class);
        registerPlugin(OvisAuthPlugin.class);
        registerPlugin(SaveImagePlugin.class);
        registerPlugin(OvisDirectPlugin.class);
        String link = takeAppLink(getIntent(), savedInstanceState == null);
        if (link != null) openAppLink(link);
        // the PC's key: its origin, or its scope on the hosted shell's origin for a relay PC. An
        // app link waiting for the connect screen shows that screen first
        String pc = PCStore.link != null ? null : PCStore.current(this);
        String origin = pc == null ? null : PCStore.origin(pc);
        String host = origin == null ? null : Uri.parse(origin).getHost();
        if (host != null) {
            boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            // Capacitor makes server.url the bridge's origin rule, which takes no path, query or
            // trailing slash: such a rule throws, and Capacitor falls back to a bridge that every
            // frame (a preview's iframe included) can call. So server.url is the bare origin, and a
            // pairing link's path, query and fragment (a relay offer's `#offer=`) come in as the start
            // path until a PC page has loaded; a relay PC starts at its scope after that.
            config = new CapConfig.Builder(this)
                .setServerUrl(origin)
                .setStartPath(PCStore.startPath(PCStore.pendingStart, pc))
                // No allowNavigation: the PC's own pages stay in the WebView already, and Capacitor
                // turns each entry into another bridge origin rule (https://host, or a host starting
                // with "http" as is: invalid, which again drops the bridge's origin check). Links to
                // any other origin, another port on the PC's host included, go to the browser
                // (shouldOverrideUrlLoading below).
                .setErrorPath("error.html")
                .setBackgroundColor("#12100e")
                .setWebContentsDebuggingEnabled(debuggable)
                // Capacitor's log has "Loading app at" with a pairing link's code, and every plugin
                // call's arguments; logcat keeps them on the phone (capacitor.config.json turns it
                // off for the connect screen)
                .setLoggingEnabled(false)
                // light icons on the app's dark background until a page gives its theme-color, as
                // capacitor.config.json does for the connect screen: Capacitor's SystemBars would
                // otherwise follow the phone's light mode with dark icons
                .setPluginsConfiguration(new JSObject().put("SystemBars", new JSObject().put("style", "DARK")))
                .create();
        }
        super.onCreate(savedInstanceState);
        keepClearOfNavigationButtons();
        String appOrigin = bridge.getScheme() + "://" + bridge.getHost();
        followThemeColor(host == null ? Collections.singleton(appOrigin) : new HashSet<>(Arrays.asList(appOrigin, origin)));
        if (host != null) {
            // CapacitorCookies is off (not in the plugins configuration), yet its load() still adds a
            // JavaScript interface whose setCookie writes a cookie for any origin, open to every page
            // and frame: a sign-in page in front of the PC must not reach it. Capacitor's page script
            // looks for it before use. Pages loaded from now on no longer see it.
            bridge.getWebView().removeJavascriptInterface("CapacitorCookiesAndroidInterface");
            // Capacitor injects its bridge only into the PC's origin, so error.html (served from the
            // app while a PC is open) reaches the app through this listener instead. It answers only
            // the app's own origin in the main frame: a PC page or a frame it opens gets nothing.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(
                    bridge.getWebView(),
                    "HerdrErrorPage",
                    Collections.singleton(appOrigin),
                    (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        if (!isMainFrame) return;
                        String asked = message.getData();
                        if ("state".equals(asked)) {
                            String last = PCStore.last(this);
                            JSObject state = new JSObject();
                            state.put("last", last == null ? "" : last);
                            state.put("name", last == null ? "" : PCStore.names(this).optString(last, ""));
                            state.put("failure", PCStore.failure == null ? "" : PCStore.failure);
                            state.put("kind", PCStore.failureKind == null ? "" : PCStore.failureKind);
                            replyProxy.postMessage(state.toString());
                        } else if ("retry".equals(asked)) {
                            retry();
                        } else if ("changePc".equals(asked)) {
                            changePc();
                        }
                    }
                );
            }
            bridge.setWebViewClient(
                new BridgeWebViewClient(bridge) {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        // error.html on a WebView without HerdrErrorPage (no WEB_MESSAGE_LISTENER)
                        // asks by navigating to one of these app addresses instead
                        Uri url = request.getUrl();
                        if (
                            request.isForMainFrame() &&
                            (appOrigin + "/error.html").equals(view.getUrl()) &&
                            appOrigin.equals(url.getScheme() + "://" + url.getHost())
                        ) {
                            if ("/_ovis/retry".equals(url.getPath())) {
                                retry();
                                return true;
                            }
                            if ("/_ovis/change-pc".equals(url.getPath())) {
                                changePc();
                                return true;
                            }
                        }
                        // the sign-in's steps in the WebView, judged one by one
                        if (
                            signingIn &&
                            request.isForMainFrame() &&
                            ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) &&
                            !appOrigin.equals(url.getScheme() + "://" + url.getHost())
                        ) {
                            if (refuseSignInStep(url.toString(), pc)) return true;
                            signInAt = PCStore.origin(url.toString());
                            return false;
                        }
                        // Capacitor gives the browser any other host or scheme, redirects included. Until the
                        // first page shows, a redirect can only come from the address being opened
                        if (!pageShown && request.isForMainFrame() && request.isRedirect()) {
                            String next = PCStore.origin(url.toString());
                            if (next != null && !next.equals(origin)) {
                                followRedirect(origin, url.toString());
                                return true;
                            }
                        }
                        // Capacitor keeps a link in the WebView when only its scheme and host match the PC's,
                        // so another server on the PC's host (a dev server on another port) would replace Ovis
                        // with no way back. A page of another origin, port included, goes to the browser.
                        if (
                            request.isForMainFrame() &&
                            ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) &&
                            !PCStore.sameOrigin(url.toString(), origin) &&
                            !PCStore.sameOrigin(url.toString(), appOrigin)
                        ) {
                            Intent browse = new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE);
                            try {
                                startActivity(browse);
                            } catch (ActivityNotFoundException noBrowser) {
                                // nothing to open it with: the link does nothing, Ovis stays
                            }
                            return true;
                        }
                        return super.shouldOverrideUrlLoading(view, request);
                    }

                    // WebView does not ask shouldOverrideUrlLoading about a form's POST: a sign-in form
                    // posting over plain http is held here, before anything is sent, and a POST that goes
                    // on is where the next step is judged from. WebView follows a POST's redirects with
                    // no callback, so those stay unchecked (the check is best effort)
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        Uri url = request.getUrl();
                        if (
                            signingIn &&
                            request.isForMainFrame() &&
                            "POST".equalsIgnoreCase(request.getMethod()) &&
                            ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) &&
                            !appOrigin.equals(url.getScheme() + "://" + url.getHost())
                        ) {
                            if (refuseSignInStep(url.toString(), pc)) {
                                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                            }
                            signInAt = PCStore.origin(url.toString());
                        }
                        return super.shouldInterceptRequest(view, request);
                    }

                    // Capacitor tells its listeners of every failed request, a picture or a frame
                    // included, and not which one or why: only a failure of the page itself keeps the
                    // PC out of the saved list, and its reason goes to error.html, which Capacitor
                    // shows for both.
                    @Override
                    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                        if (request.isForMainFrame()) {
                            // the load dropped at the time limit, which the error page already explains
                            if (gaveUp && !pageShown) return;
                            pageFailed = true;
                            PCStore.fail(String.valueOf(error.getDescription()), null);
                        }
                        super.onReceivedError(view, request, error);
                    }

                    @Override
                    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                        // a PC that answers but not with Ovis, such as tailscale serve's 502 while Ovis
                        // is stopped there
                        if (request.isForMainFrame()) {
                            pageFailed = true;
                            String reason = response.getReasonPhrase();
                            PCStore.fail("HTTP " + response.getStatusCode() + (reason == null || reason.isEmpty() ? "" : " " + reason), null);
                        }
                        super.onReceivedHttpError(view, request, response);
                    }
                }
            );
            bridge.addWebViewListener(
                new WebViewListener() {
                    @Override
                    public void onPageStarted(WebView webView) {
                        pageFailed = false;
                    }

                    @Override
                    public void onPageCommitVisible(WebView webView, String url) {
                        // the main frame's first page is on screen, before its pictures or scripts finish:
                        // the PC's, a sign-in's or the error page
                        pageShown = true;
                        hideOpening();
                    }

                    @Override
                    public void onPageLoaded(WebView webView) {
                        // Chromium reports a page that failed as loaded too, before the error page;
                        // only a page of this very PC (its scheme, host and port, and its scope for a relay PC) counts
                        String url = webView.getUrl();
                        if (pageFailed || url == null || !PCStore.belongs(url, pc)) return;
                        // the PC's page is up: a pairing link has done its work
                        signingIn = false;
                        PCStore.pendingStart = null;
                        PCStore.fail(null, null);
                        PCStore.redirects = 0;
                        keepIfOvis(pc, url);
                    }
                }
            );
            showOpening(pc);
        }
    }

    /**
     * Keeps the PC `pc`, whose page `url` has loaded, unless it is not Ovis: a web server that is not
     * Ovis would otherwise be saved and opened at every start, with no Change PC and Back closing the
     * app. That page gives way to the error page, which has Change PC, and the PC is not kept (one
     * kept before stays in the list until forgotten). Only an answer that shows it is not Ovis (its
     * page loads, its /api/health is not Ovis's) counts: a PC that could not be asked, or answered
     * the question with 403 or 502, is kept as before, also when the activity ended meanwhile. A relay PC (a scope on the hosted app) is the hosted
     * app's, which the connect screen checked (relayLink in app/web/shell.js).
     */
    private void keepIfOvis(String pc, String url) {
        if (PCStore.scoped(pc)) {
            PCStore.remember(this, pc);
            return;
        }
        // once per activity: the PC's later pages are the same server
        if (checked) return;
        checked = true;
        String cookies = CookieManager.getInstance().getCookie(url);
        android.content.Context app = getApplicationContext();
        long since = PCStore.forgetCount();
        new Thread(() -> {
            PCStore.Check found = PCStore.check(url, cookies, PCStore.ANSWER_SECONDS * 1000L);
            if (!found.kind.equals("not-ovis")) {
                // the check may outlive this activity: a PC forgotten meanwhile stays forgotten
                PCStore.rememberUnlessForgotten(app, pc, since);
                return;
            }
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                PCStore.fail(found.detail == null ? "It answered, but not as Ovis." : "It answered " + found.detail + ", not as Ovis.", "not-ovis");
                bridge.getWebView().loadUrl(bridge.getErrorUrl());
            });
        }, "ovis-check").start();
    }

    private static boolean korean() {
        return "ko".equals(Locale.getDefault().getLanguage());
    }

    /**
     * Covers the WebView until the PC answers (onPageCommitVisible), as the iOS app's cover does: which
     * PC is opening, and Change PC, so an address that does not answer never leaves a blank screen.
     * After ANSWER_SECONDS the app stops waiting and the error page says so, with Try again.
     */
    private void showOpening(String pc) {
        String origin = PCStore.origin(pc);
        String label = PCStore.names(this).optString(pc, "");
        if (label.isEmpty()) label = origin == null ? pc : Uri.parse(origin).getAuthority();
        float density = getResources().getDisplayMetrics().density;
        int pad = Math.round(24 * density);

        ProgressBar spinner = new ProgressBar(this);
        spinner.setIndeterminate(true);
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(Color.parseColor("#f0a830")));
        TextView text = new TextView(this);
        text.setText(korean() ? label + " 여는 중…" : "Opening " + label + "…");
        text.setTextColor(Color.parseColor("#d8d0c3"));
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        text.setGravity(Gravity.CENTER);
        text.setPadding(0, pad / 2, 0, pad);
        Button change = new Button(this);
        change.setText(korean() ? "PC 바꾸기" : "Change PC");
        change.setAllCaps(false);
        change.setTextColor(Color.parseColor("#f2ebdf"));
        change.setBackgroundColor(Color.parseColor("#181613"));
        change.setPadding(pad, pad / 2, pad, pad / 2);
        change.setOnClickListener(v -> changePc());

        LinearLayout stack = new LinearLayout(this);
        stack.setOrientation(LinearLayout.VERTICAL);
        stack.setGravity(Gravity.CENTER);
        stack.setPadding(pad, pad, pad, pad);
        stack.addView(spinner);
        stack.addView(text);
        stack.addView(change);
        FrameLayout cover = new FrameLayout(this);
        cover.setBackgroundColor(Color.parseColor("#12100e"));
        // taps stop here, not on the blank WebView under it
        cover.setClickable(true);
        cover.addView(stack, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        addContentView(cover, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        openingView = cover;
        answerTimer.postDelayed(() -> {
            if (openingView == null || isFinishing() || isDestroyed()) return;
            gaveUp = true;
            String host = origin == null ? pc : Uri.parse(origin).getAuthority();
            PCStore.fail(host + " did not answer within " + PCStore.ANSWER_SECONDS + " seconds.", "timeout");
            bridge.getWebView().stopLoading();
            bridge.getWebView().loadUrl(bridge.getErrorUrl());
        }, answerDelay());
    }

    /**
     * How long the cover waits: what is left of the limit the connect screen's check started
     * (PCStore.answerBy), at least PAGE_FLOOR_MS, or ANSWER_SECONDS for an open that started here (a
     * saved PC at launch, Try again, a redirect to Ovis). The limit is taken once.
     */
    private static long answerDelay() {
        long by = PCStore.answerBy;
        PCStore.answerBy = 0;
        if (by == 0) return PCStore.ANSWER_SECONDS * 1000L;
        return Math.max(PCStore.PAGE_FLOOR_MS, by - android.os.SystemClock.elapsedRealtime());
    }

    private void hideOpening() {
        answerTimer.removeCallbacksAndMessages(null);
        if (openingView == null) return;
        ((ViewGroup) openingView.getParent()).removeView(openingView);
        openingView = null;
    }

    @Override
    public void onDestroy() {
        answerTimer.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    /**
     * Lets the pages of `origins` color the status and navigation bars with their theme-color.
     * Without it the bars keep the app's dark background and light icons.
     */
    private void followThemeColor(Set<String> origins) {
        if (
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) return;
        try {
            WebViewCompat.addWebMessageListener(
                bridge.getWebView(),
                "OvisBars",
                origins,
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (!isMainFrame || message.getData() == null) return;
                    String color = message.getData().trim();
                    if (!color.matches("#[0-9a-fA-F]{6}")) return;
                    paintBars(Color.parseColor(color));
                }
            );
            WebViewCompat.addDocumentStartJavaScript(bridge.getWebView(), BAR_COLOR_SCRIPT, origins);
        } catch (IllegalArgumentException rejectedOrigin) {
            return; // Keep the default bars when WebView rejects an origin rule.
        }
        bridge.getWebView().evaluateJavascript(BAR_COLOR_SCRIPT, null);
    }

    /**
     * Keeps the page clear of navigation buttons (3-button navigation: the bottom bar, or the side bar
     * of a phone in landscape). On a WebView that gives the page its safe areas itself (140 and
     * later), Capacitor's SystemBars lets the page draw under the system bars and leaves the room to
     * the page's CSS, and the client lets its message box and key bar sit partly into the bottom safe
     * area, as an iPhone's home indicator allows: there the buttons cover them. The client's layout
     * pads its sides for a side bar; the page is kept clear of one too, so that nothing on it has to.
     * A gesture bar has no tappable inset, so the page stays under it. A docked
     * keyboard covers a bottom bar, and SystemBars keeps the page above both. A floating keyboard
     * takes no bottom inset, so on WebView 144 and later the bar is kept clear under it; before 144
     * SystemBars passes the page no bottom inset while any keyboard shows, so nothing is padded then.
     * On an older WebView SystemBars keeps the page out from under the bars itself, so the page gets
     * no such insets and nothing changes.
     */
    private void keepClearOfNavigationButtons() {
        View page = (View) bridge.getWebView().getParent();
        int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
        ViewCompat.setOnApplyWindowInsetsListener(page, (view, insets) -> {
            Insets under = insets.getInsets(bars);
            Insets buttons = insets.getInsets(WindowInsetsCompat.Type.tappableElement());
            boolean keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom > 0;
            Insets clear = Insets.of(
                Math.min(buttons.left, under.left),
                0,
                Math.min(buttons.right, under.right),
                keyboard ? 0 : Math.min(buttons.bottom, under.bottom)
            );
            // the strip shows the window's background: the page's theme-color once it has sent one
            // (paintBars), the app's dark background before
            view.setPadding(clear.left, 0, clear.right, clear.bottom);
            if (clear.equals(Insets.NONE)) return insets;
            return new WindowInsetsCompat.Builder(insets).setInsets(bars, Insets.subtract(under, clear)).build();
        });
    }

    /**
     * The color behind the system bars (the strip Capacitor leaves when the page does not draw under
     * them) and icons that stand out on it, light or dark.
     */
    private void paintBars(int color) {
        barColor = color;
        Window window = getWindow();
        window.getDecorView().setBackgroundColor(color);
        boolean lightBars = ColorUtils.calculateLuminance(color) > 0.18;
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
        bars.setAppearanceLightStatusBars(lightBars);
        bars.setAppearanceLightNavigationBars(lightBars);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        // Capacitor's SystemBars puts the theme's bars back on a change (dark mode, rotation)
        super.onConfigurationChanged(newConfig);
        if (barColor != null) paintBars(barColor);
    }

    @Override
    public void onPause() {
        super.onPause();
        // WebView writes cookies to disk on its own schedule: a paired device's sign-in set a moment
        // ago would be lost if the app were swiped away now
        CookieManager.getInstance().flush();
    }

    /**
     * A redirect of the address being opened to another origin, held back: when that origin answers as
     * Ovis it becomes the PC and opens as the first page, with the bridge (http to https, an IP address
     * to the PC's name, another port). Anything else is taken for a sign-in in front of the PC (an
     * authenticating proxy such as Cloudflare Access): it loads without the bridge and is never saved
     * or made the PC, and the way back to the PC stays in the WebView (signingIn). The address's own
     * page would get the bridge too, so the place it leads to gets nothing more. Once the first page shows,
     * Capacitor decides on redirects again: one could then come from a link to a page that is not the
     * PC's (another port on its host), which must not choose the PC. A way that goes over public plain
     * http, or from https to http, does not switch on its own: the connect screen warns before a
     * public http address.
     */
    private void followRedirect(String from, String target) {
        boolean tooMany = PCStore.redirects >= PCStore.MAX_REDIRECTS;
        new Thread(() -> {
            List<String> path = new ArrayList<>();
            String ovis = tooMany ? null : PCStore.ovisOrigin(target, PCStore.PROBE_BUDGET_MS, path);
            String insecure = tooMany ? null : PCStore.refusedHop(from, target, ovis, path);
            runOnUiThread(() -> {
                // after the time limit the error page has the screen: a late answer changes nothing
                if (isFinishing() || isDestroyed() || gaveUp) return;
                if (tooMany) {
                    PCStore.fail("Too many redirects", null);
                    bridge.getWebView().loadUrl(bridge.getErrorUrl());
                } else if (insecure != null) {
                    PCStore.fail("It redirected over plain http to " + insecure + ", which the app does not follow on its own." + (ovis == null ? "" : " If " + ovis + " is your PC, open it itself."), null);
                    bridge.getWebView().loadUrl(bridge.getErrorUrl());
                } else if (ovis != null) {
                    PCStore.redirects++;
                    PCStore.open(this, ovis, PCStore.startOn(ovis, target));
                    reopen();
                } else if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                    // without it Capacitor's bridge is a JavaScript interface every page can call
                    String place = PCStore.origin(target);
                    PCStore.fail("It redirected to " + place + ", which did not answer as Ovis. If that is your PC, open " + place + " itself.", null);
                    bridge.getWebView().loadUrl(bridge.getErrorUrl());
                } else {
                    signingIn = true;
                    signInAt = PCStore.origin(target);
                    bridge.getWebView().loadUrl(target);
                }
            });
        }, "ovis-redirect").start();
    }

    /**
     * Whether the sign-in's next step, to `url`, is refused: over public plain http, or from https to
     * http (PCStore.refusedHop). The way back to the PC itself is never refused, as the user chose its
     * address. A refused step ends the sign-in on the error page. Any thread.
     */
    private boolean refuseSignInStep(String url, String pc) {
        if (PCStore.belongs(url, pc)) return false;
        String insecure = PCStore.refusedHop(signInAt, url, null, null);
        if (insecure == null) return false;
        signingIn = false;
        PCStore.fail("The sign-in went over plain http to " + insecure + ", which the app does not follow on its own.", null);
        runOnUiThread(() -> bridge.getWebView().loadUrl(bridge.getErrorUrl()));
        return true;
    }

    /** An app link while the app runs: the connect screen opens it, whatever page is showing. */
    @Override
    protected void onNewIntent(Intent intent) {
        String link = takeAppLink(intent, true);
        if (link != null && openAppLink(link)) {
            reopen();
            return;
        }
        super.onNewIntent(intent);
    }

    /**
     * Readies an app link for the next first load, or answers false and leaves the open page alone. A
     * link to pair from waits for the connect screen (PCStore.link); a view of a PC (a file, a pane)
     * opens that PC at that view when the app has it saved, as the browser would have; for any other
     * PC the app has nothing to show.
     */
    private boolean openAppLink(String link) {
        if (PCStore.pairingLink(link)) {
            PCStore.link = link;
            return true;
        }
        String scope = PCStore.appScope(link);
        if (!PCStore.saved(this).contains(scope)) return false;
        PCStore.open(this, scope, link);
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        return true;
    }

    /**
     * The app link (PCStore.appLink) `intent` carries, taken out of it so it is opened once: Capacitor's
     * load() passes the starting intent to onNewIntent again. Null for any other intent, and for a
     * link the system hands back with the activity restored or started again from Recents, which the
     * user opened before.
     */
    private static String takeAppLink(Intent intent, boolean fresh) {
        if (intent == null) return null;
        Uri data = intent.getData();
        String link = PCStore.appLink(intent.getAction(), data == null ? null : data.toString());
        if (link == null) return null;
        intent.setData(null);
        boolean fromRecents = (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        return fresh && !fromRecents ? link : null;
    }

    /** Opens the current PC again from its first page. */
    void retry() {
        PCStore.fail(null, null);
        PCStore.redirects = 0;
        reopen();
    }

    /** Back to the connect screen; the PC stays in the list. */
    void changePc() {
        PCStore.setCurrent(this, null);
        reopen();
    }

    /** Starts this activity again, so the next page (a PC, or the connect screen) is a first load. */
    void reopen() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        finish();
        overridePendingTransition(0, 0);
        startActivity(intent);
    }
}
