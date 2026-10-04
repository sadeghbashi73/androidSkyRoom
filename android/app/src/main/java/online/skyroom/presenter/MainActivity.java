package online.skyroom.presenter;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.PopupMenu;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Hosts Skyroom's web client in a WebView and adds what Android browsers lack
 * for a presenter: microphone/camera grants, a working getDisplayMedia()
 * backed by MediaProjection, and a foreground service so audio and sharing
 * survive switching to other apps.
 */
public class MainActivity extends Activity implements ClassService.ScreenListener {

    /** The bundled launcher PWA, served from the APK's assets. */
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String HOME_URL = "https://" + ASSET_HOST + "/www/index.html";

    private static final int REQ_SCREEN = 1;
    private static final int REQ_FILE = 2;
    private static final int REQ_MEDIA_PERMS = 3;
    private static final int REQ_NOTIFY = 4;

    private static final String PREFS = "settings";
    private static final String PREF_DESKTOP = "desktop_mode";

    private WebView web;
    private FrameLayout root;
    private SharedPreferences prefs;
    private String shim;
    private String mobileUa;

    private PermissionRequest pendingPermission;
    private ValueCallback<Uri[]> pendingFiles;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        shim = readAsset("screenshare-shim.js");

        WebView.setWebContentsDebuggingEnabled(
                (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0f172a"));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(menuButton());
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false); // target=_blank opens in place
        mobileUa = s.getUserAgentString();
        applyUserAgent();

        if (Build.VERSION.SDK_INT >= 26) {
            // Keep the renderer alive and responsive while another app is in front.
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        web.addJavascriptInterface(new Bridge(), "SkyroomNative");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener((url, ua, cd, mime, len) -> openExternal(Uri.parse(url)));

        ClassService.setListener(this);

        if (Build.VERSION.SDK_INT >= 33 &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(startUrl(getIntent()));
    }

    private String startUrl(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && "https".equals(data.getScheme())) return data.toString();
        return HOME_URL;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) web.loadUrl(startUrl(intent));
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    // We deliberately do NOT call web.onPause() in onPause(): the class (audio,
    // screen frames) has to keep running while the user shows another app.

    @Override
    protected void onDestroy() {
        ClassService.setListener(null);
        if (isFinishing()) stopClassService();
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (customView != null) { hideCustomView(); return; }
        if (web.canGoBack()) { web.goBack(); return; }
        super.onBackPressed();
    }

    /* ------------------------------------------------------------------ *
     * Menu
     * ------------------------------------------------------------------ */

    private View menuButton() {
        TextView b = new TextView(this);
        b.setText("☰");
        b.setTextSize(18);
        b.setTextColor(Color.WHITE);
        b.setGravity(Gravity.CENTER);
        b.setBackgroundResource(R.drawable.fab_bg);
        b.setElevation(8 * getResources().getDisplayMetrics().density);
        b.setContentDescription("منو");
        int size = dp(42), margin = dp(10);
        // Mid-left edge: clear of Skyroom's top/bottom toolbars and page FABs.
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(size, size, Gravity.CENTER_VERTICAL | Gravity.START);
        lp.setMargins(margin, 0, margin, 0);
        b.setAlpha(0.75f);
        b.setLayoutParams(lp);
        b.setOnClickListener(this::showMenu);
        return b;
    }

    private static final int M_HOME = 1, M_RELOAD = 2, M_DESKTOP = 3, M_STOP_SHARE = 4,
            M_BROWSER = 5, M_EXIT = 6;

    private void showMenu(View anchor) {
        PopupMenu pm = new PopupMenu(this, anchor);
        Menu m = pm.getMenu();
        m.add(0, M_HOME, 0, "صفحه اصلی (کلاس‌های من)");
        m.add(0, M_RELOAD, 1, "بارگذاری مجدد");
        m.add(0, M_DESKTOP, 2, "حالت دسکتاپ (نوار ابزار کامل پرزنتر)")
                .setCheckable(true).setChecked(isDesktopMode());
        if (ClassService.isSharing()) m.add(0, M_STOP_SHARE, 3, "توقف اشتراک صفحه");
        m.add(0, M_BROWSER, 4, "باز کردن در مرورگر");
        m.add(0, M_EXIT, 5, "خروج کامل از کلاس");
        pm.setOnMenuItemClickListener(this::onMenu);
        pm.show();
    }

    private boolean onMenu(MenuItem item) {
        switch (item.getItemId()) {
            case M_HOME: web.loadUrl(HOME_URL); return true;
            case M_RELOAD: web.reload(); return true;
            case M_DESKTOP:
                prefs.edit().putBoolean(PREF_DESKTOP, !isDesktopMode()).apply();
                applyUserAgent();
                web.reload();
                toast(isDesktopMode() ? "حالت دسکتاپ فعال شد" : "حالت موبایل فعال شد");
                return true;
            case M_STOP_SHARE: sendToService(ClassService.ACTION_STOP_PROJECTION); return true;
            case M_BROWSER:
                String url = web.getUrl();
                if (url != null && !url.contains(ASSET_HOST)) openExternal(Uri.parse(url));
                return true;
            case M_EXIT:
                stopClassService();
                finishAndRemoveTask();
                return true;
        }
        return false;
    }

    /* ------------------------------------------------------------------ *
     * User agent
     * ------------------------------------------------------------------ */

    private boolean isDesktopMode() { return prefs.getBoolean(PREF_DESKTOP, true); }

    private void applyUserAgent() {
        if (!isDesktopMode()) { web.getSettings().setUserAgentString(mobileUa); return; }
        Matcher m = Pattern.compile("Chrome/([\\d.]+)").matcher(mobileUa);
        String ver = m.find() ? m.group(1) : "130.0.0.0";
        web.getSettings().setUserAgentString("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + ver + " Safari/537.36");
    }

    /* ------------------------------------------------------------------ *
     * JavaScript bridge (see assets/screenshare-shim.js)
     * ------------------------------------------------------------------ */

    private class Bridge {
        @JavascriptInterface public boolean isApp() { return true; }
        @JavascriptInterface public String appVersion() { return BuildConfig.VERSION_NAME; }
        @JavascriptInterface public boolean isDesktopMode() { return MainActivity.this.isDesktopMode(); }
        @JavascriptInterface public boolean isSharing() { return ClassService.isSharing(); }

        /** Shows Android's own "start recording/casting" consent dialog. */
        @JavascriptInterface public void requestScreen() {
            runOnUiThread(() -> {
                MediaProjectionManager mpm = getSystemService(MediaProjectionManager.class);
                try {
                    startActivityForResult(mpm.createScreenCaptureIntent(), REQ_SCREEN);
                } catch (ActivityNotFoundException e) {
                    onScreenError("این گوشی از ضبط صفحه پشتیبانی نمی‌کند");
                }
            });
        }

        @JavascriptInterface public void stopScreen() {
            runOnUiThread(() -> {
                if (ClassService.isSharing()) sendToService(ClassService.ACTION_STOP_PROJECTION);
            });
        }
    }

    // ScreenListener — called on the main thread by ClassService.
    @Override public void onScreenStart(int w, int h) {
        js("window.__srsOnStart&&__srsOnStart(" + w + "," + h + ")");
        toast("اشتراک صفحه شروع شد — حالا می‌توانید به برنامه دیگری بروید");
    }
    @Override public void onScreenFrame(String b64) { js("window.__srsFrame&&__srsFrame('" + b64 + "')"); }
    @Override public void onScreenEnd() { js("window.__srsOnEnd&&__srsOnEnd()"); }
    @Override public void onScreenError(String message) {
        js("window.__srsOnError&&__srsOnError(" + jsString(message) + ")");
        toast(message);
    }

    private void js(String code) { if (web != null) web.evaluateJavascript(code, null); }

    private static String jsString(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'";
    }

    private void injectShim() { if (shim != null) web.evaluateJavascript(shim, null); }

    /* ------------------------------------------------------------------ *
     * Activity results
     * ------------------------------------------------------------------ */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SCREEN) {
            if (resultCode != RESULT_OK || data == null) {
                onScreenError("اجازه اشتراک صفحه داده نشد");
                return;
            }
            Intent i = new Intent(this, ClassService.class)
                    .setAction(ClassService.ACTION_START_PROJECTION)
                    .putExtra(ClassService.EXTRA_RESULT_CODE, resultCode)
                    .putExtra(ClassService.EXTRA_RESULT_DATA, data);
            startService(i, true);
        } else if (requestCode == REQ_FILE && pendingFiles != null) {
            pendingFiles.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            pendingFiles = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode != REQ_MEDIA_PERMS || pendingPermission == null) return;
        PermissionRequest req = pendingPermission;
        pendingPermission = null;
        String[] granted = grantableResources(req.getResources());
        if (granted.length > 0) {
            req.grant(granted);
            onMediaGranted();
        } else {
            req.deny();
            toast("بدون اجازه میکروفون، صدای شما در کلاس شنیده نمی‌شود");
        }
    }

    /* ------------------------------------------------------------------ *
     * Microphone / camera for the page
     * ------------------------------------------------------------------ */

    private static String androidPermFor(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return Manifest.permission.CAMERA;
        return null;
    }

    /** The subset of requested web resources whose Android permission we hold. */
    private String[] grantableResources(String[] resources) {
        List<String> out = new ArrayList<>();
        for (String r : resources) {
            String p = androidPermFor(r);
            if (p != null && checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED) out.add(r);
            else if (PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID.equals(r)) out.add(r);
        }
        return out.toArray(new String[0]);
    }

    private void onMediaGranted() {
        // Keep the microphone alive while the user is in other apps.
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startService(new Intent(this, ClassService.class).setAction(ClassService.ACTION_KEEPALIVE), true);
        }
    }

    /* ------------------------------------------------------------------ *
     * Service helpers
     * ------------------------------------------------------------------ */

    private void startService(Intent i, boolean foreground) {
        try {
            if (foreground && Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (RuntimeException e) {
            if (ClassService.ACTION_START_PROJECTION.equals(i.getAction()))
                onScreenError("اجرای سرویس اشتراک صفحه ممکن نشد");
        }
    }

    private void sendToService(String action) {
        try { startService(new Intent(this, ClassService.class).setAction(action)); }
        catch (RuntimeException ignored) { }
    }

    private void stopClassService() {
        sendToService(ClassService.ACTION_STOP);
    }

    /* ------------------------------------------------------------------ *
     * WebView clients
     * ------------------------------------------------------------------ */

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            String scheme = uri.getScheme();
            if ("https".equals(scheme) || "http".equals(scheme)) return false;
            if ("intent".equals(scheme)) {
                try {
                    Intent i = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                    i.addCategory(Intent.CATEGORY_BROWSABLE);
                    i.setComponent(null);
                    i.setSelector(null);
                    startActivity(i);
                } catch (Exception e) {
                    toast("برنامه مناسب برای این لینک پیدا نشد");
                }
                return true;
            }
            openExternal(uri);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!ASSET_HOST.equals(u.getHost())) return null;
            return serveAsset(u.getPath());
        }

        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
            injectShim();
        }

        @Override public void onPageFinished(WebView view, String url) { injectShim(); }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The renderer was killed (low memory). Rebuild instead of crashing.
            if (ClassService.isSharing()) sendToService(ClassService.ACTION_STOP_PROJECTION);
            recreate();
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override public void onProgressChanged(WebView view, int progress) {
            // Idempotent; makes getDisplayMedia available as early as possible.
            injectShim();
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> {
                List<String> missing = new ArrayList<>();
                for (String r : request.getResources()) {
                    String p = androidPermFor(r);
                    if (p != null && checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
                }
                if (missing.isEmpty()) {
                    String[] granted = grantableResources(request.getResources());
                    if (granted.length > 0) { request.grant(granted); onMediaGranted(); }
                    else request.deny();
                    return;
                }
                if (pendingPermission != null) pendingPermission.deny();
                pendingPermission = request;
                requestPermissions(missing.toArray(new String[0]), REQ_MEDIA_PERMS);
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingPermission == request) pendingPermission = null;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (pendingFiles != null) pendingFiles.onReceiveValue(null);
            pendingFiles = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILE);
            } catch (ActivityNotFoundException e) {
                pendingFiles = null;
                return false;
            }
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) { callback.onCustomViewHidden(); return; }
            customView = view;
            customViewCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }

        @Override public void onHideCustomView() { hideCustomView(); }
    }

    private void hideCustomView() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
    }

    /* ------------------------------------------------------------------ *
     * Local launcher assets
     * ------------------------------------------------------------------ */

    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.contains("..")) return notFound();
        String file = path.startsWith("/") ? path.substring(1) : path;
        if (file.endsWith("/")) file += "index.html";
        try {
            InputStream in = getAssets().open(file);
            WebResourceResponse r = new WebResourceResponse(mimeFor(file), null, in);
            return r;
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8", null);
        r.setStatusCodeAndReasonPhrase(404, "Not Found");
        return r;
    }

    private static String mimeFor(String f) {
        if (f.endsWith(".html")) return "text/html";
        if (f.endsWith(".js")) return "text/javascript";
        if (f.endsWith(".css")) return "text/css";
        if (f.endsWith(".svg")) return "image/svg+xml";
        if (f.endsWith(".png")) return "image/png";
        if (f.endsWith(".json") || f.endsWith(".webmanifest")) return "application/json";
        return "application/octet-stream";
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            return null;
        }
    }

    /* ------------------------------------------------------------------ *
     * Misc
     * ------------------------------------------------------------------ */

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            toast("برنامه مناسب برای این لینک پیدا نشد");
        }
    }

    private void toast(String msg) { Toast.makeText(this, msg, Toast.LENGTH_LONG).show(); }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
}
