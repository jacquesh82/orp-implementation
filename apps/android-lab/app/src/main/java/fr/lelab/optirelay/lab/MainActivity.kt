package fr.lelab.optirelay.lab

import android.Manifest
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.io.File

/**
 * OptiRelay Android: a WebView embedding the `apps/web` PWA (main screen)
 * and the `apps/lab` test bench (linked from the PWA) — @optirelay SDK,
 * D-009: no engine duplicated on the Android side.
 *
 * Two platform requirements:
 *   1. SECURE CONTEXT — getUserMedia requires it: the content is served by
 *      WebViewAssetLoader on a dedicated https origin (never file://);
 *   2. MAXIMUM BRIGHTNESS — the optical matrices must be shown at full
 *      brightness, and the screen must not lock in the middle of a transfer.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) webView.reload()
        }

    /** Return from the slow-motion filming screen: handed back to the page (filmSlowMotion). */
    private val shooting =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            val json = r.data?.getStringExtra(SlowMotionActivity.RESULT)
                ?: JSONObject().put("error", "Filming cancelled.").toString()
            webView.evaluateJavascript(
                "window.__optirelaySlowMotion && window.__optirelaySlowMotion(${JSONObject.quote(json)})",
                null,
            )
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Test bench: forced brightness and screen kept on (§5.3: the test
        // pattern must be captured under controlled conditions).
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.attributes = window.attributes.apply {
            screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
        }

        // Ordinary Android window: status bar and navigation bar visible, the
        // page in between. Android 15 (target 35) enforces edge-to-edge
        // display: the bars' space is given back as padding.
        webView = WebView(this)
        val frame = FrameLayout(this).apply {
            setBackgroundColor(Color.WHITE)
            addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        }
        setContentView(frame)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        WindowInsetsControllerCompat(window, frame).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }

        // Videos filmed in slow motion (SlowMotionActivity) are served to the
        // page on the same origin: https://appassets.androidplatform.net/slowmotion/…
        val slowMotionDir = File(cacheDir, "slowmotion").apply { mkdirs() }
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/slowmotion/", WebViewAssetLoader.InternalStoragePathHandler(this, slowMotionDir))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
        }
        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // A single origin: the bench navigates nowhere else.
                return request.url.host != "appassets.androidplatform.net"
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val camera = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.CAMERA,
                ) == PackageManager.PERMISSION_GRANTED
                runOnUiThread {
                    if (camera && request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                        request.grant(request.resources)
                    } else {
                        request.deny()
                    }
                }
            }

            override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
                android.util.Log.i(
                    "OptiRelayLab",
                    "[${message.messageLevel()}] ${message.sourceId()}:${message.lineNumber()} ${message.message()}",
                )
                return true
            }
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
        // Minimal bridge to native code: save a received file to Downloads.
        // A WebView cannot follow a blob: “download” link; this is the only
        // native action the PWA needs.
        webView.addJavascriptInterface(FileBridge(), "OptiRelayAndroid")
        webView.loadUrl("https://appassets.androidplatform.net/assets/app/index.html")
        onBackPressedDispatcher.addCallback(this, back)
    }

    /**
     * BACK key: first the page (the app is a single page with screens — it
     * closes the open screen like its own “Close / Cancel” button), then the
     * WebView history (app ↔ bench), and only then do we quit.
     */
    private val back = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            webView.evaluateJavascript("(typeof window.__optirelayBack === 'function' && window.__optirelayBack()) === true") { processed ->
                if (processed == "true") return@evaluateJavascript
                if (webView.canGoBack()) {
                    webView.goBack()
                    return@evaluateJavascript
                }
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        }
    }

    /** Exposed to the page as `window.OptiRelayAndroid` — nothing else is reachable. */
    private inner class FileBridge {
        /**
         * Opens the slow-motion filming screen; the page receives the result
         * through `window.__optirelaySlowMotion(json)`. The page has CLOSED its camera first.
         */
        @JavascriptInterface
        fun filmSlowMotion(maxSeconds: Int): Boolean {
            runOnUiThread {
                shooting.launch(Intent(this@MainActivity, SlowMotionActivity::class.java).putExtra(SlowMotionActivity.EXTRA_SECONDS, maxSeconds))
            }
            return true
        }

        @JavascriptInterface
        fun save(name: String, type: String, base64: String): Boolean = try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val nameOn = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "optirelay-received.bin" }
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, nameOn)
                put(MediaStore.Downloads.MIME_TYPE, type.ifBlank { "application/octet-stream" })
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw IllegalStateException("MediaStore refused the insert")
            resolver.openOutputStream(uri)!!.use { it.write(bytes) }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            true
        } catch (e: Exception) {
            android.util.Log.w("OptiRelayLab", "save refused: ${e.message}")
            false
        }
    }
}
