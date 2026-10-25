package dev.dsh.bridge

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.net.http.SslError
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import kotlin.math.roundToInt
import java.security.MessageDigest

/**
 * A WebView shell around one DSH instance reached through the relay.
 *
 * Only two things are baked in: the relay base URL and its access key. The DSH launch
 * token is *not* baked in — it changes every time DSH restarts.
 *
 * The hand-off is deliberately plain HTTP, with no injected JavaScript:
 *
 *   GET /ssh-bridge?rk=<key>&go=1
 *     -> relay authenticates the key and answers 302 to the current pairing link
 *     -> the plugin's 302 forces a new connection, so the relay gate runs again and
 *        issues its own cookie
 *     -> DSH exchanges the launch token for its cookie and redirects to the app
 *
 * Text size follows Android's system font-size setting by default, and the 「Aa」 button
 * pins a per-app zoom instead. Both go through WebSettings.textZoom, which scales text
 * without changing the page's own layout units.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private val prefs by lazy { getSharedPreferences("dsh-bridge", Context.MODE_PRIVATE) }

    /** Where the bootstrap starts: hand straight off to DSH. */
    private val bootstrapUrl: String
        get() = "${BuildConfig.RELAY_BASE}/ssh-bridge?rk=${BuildConfig.ACCESS_KEY}&go=1"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        CookieManager.getInstance().setAcceptCookie(true)

        web = WebView(this)
        /* Match the launch theme so the first frame is not a white flash. */
        web.setBackgroundColor(Color.parseColor("#12203A"))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            /* Pinch-to-zoom stays available for anything textZoom cannot fix. */
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.webViewClient = object : WebViewClient() {
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                if (matchesPinnedCertificate(error)) handler.proceed() else handler.cancel()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                showFailure("无法加载页面", "${error.errorCode}: ${error.description}\n${request.url}")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (!request.isForMainFrame) return
                showFailure("服务器返回 ${response.statusCode}", request.url.toString())
            }
        }

        val root = FrameLayout(this)
        root.addView(web, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))
        root.addView(buildZoomButton(), FrameLayout.LayoutParams(
            (40 * resources.displayMetrics.density).toInt(),
            (40 * resources.displayMetrics.density).toInt(),
            Gravity.BOTTOM or Gravity.END,
        ).apply {
            setMargins(0, 0, (10 * resources.displayMetrics.density).toInt(), (10 * resources.displayMetrics.density).toInt())
        })
        setContentView(root)

        applyTextZoom()
        web.loadUrl(bootstrapUrl)
    }

    /**
     * The small 「Aa」 affordance that opens the text-size dialog.
     * Kept faint and in the corner so it does not compete with DSH's own controls.
     */
    private fun buildZoomButton(): TextView = TextView(this).apply {
        text = "Aa"
        setTextColor(Color.parseColor("#E2E8F0"))
        textSize = 14f
        typeface = Typeface.DEFAULT_BOLD
        gravity = Gravity.CENTER
        alpha = 0.55f
        setBackgroundColor(Color.parseColor("#1B2F52"))
        setOnClickListener { showTextSizeDialog() }
    }

    /** Present the text-size choices, remembering the picked zoom. */
    private fun showTextSizeDialog() {
        val labels = arrayOf("跟随系统", "90%", "100%", "115%", "130%", "150%")
        val values = floatArrayOf(-1f, 0.9f, 1.0f, 1.15f, 1.3f, 1.5f)
        val current = prefs.getFloat(KEY_ZOOM, -1f)
        val selected = values.indexOfFirst { it == current }.coerceAtLeast(0)

        AlertDialog.Builder(this)
            .setTitle("字号")
            .setSingleChoiceItems(labels, selected) { dialog, which ->
                prefs.edit().putFloat(KEY_ZOOM, values[which]).apply()
                applyTextZoom()
                dialog.dismiss()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * Apply the configured zoom, resolving 「跟随系统」 against the Android font scale.
     * Clamped so a bad value cannot make the page unusable.
     */
    private fun applyTextZoom() {
        val pinned = prefs.getFloat(KEY_ZOOM, -1f)
        val scale = if (pinned <= 0f) resources.configuration.fontScale else pinned
        val zoom = (scale * 100f).roundToInt().coerceIn(60, 250)
        web.settings.textZoom = zoom
    }

    /**
     * Replace a blank screen with something that says what went wrong.
     * @param title - Short failure summary.
     * @param detail - Underlying error text.
     */
    private fun showFailure(title: String, detail: String) {
        val html = """
            <!doctype html><meta charset="utf-8">
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="font:15px/1.6 system-ui;background:#12203A;color:#E2E8F0;padding:1.5rem">
            <h1 style="font-size:1.1rem;margin:0 0 .5rem">${escape(title)}</h1>
            <pre style="white-space:pre-wrap;word-break:break-all;font:12px/1.5 ui-monospace;
                        background:rgba(255,255,255,.06);padding:.7rem;border-radius:.5rem">${escape(detail)}</pre>
            <p style="opacity:.7;font-size:.9rem">relay: ${escape(BuildConfig.RELAY_BASE)}</p>
            <p><a href="${escape(bootstrapUrl)}" style="color:#38BDF8">重试</a></p>
            </body>
        """.trimIndent()
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    /**
     * Escape text for the failure page.
     * @param value - Raw text.
     * @return HTML-safe text.
     */
    private fun escape(value: String): String = value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    /**
     * Compare the presented certificate against the pinned relay fingerprint.
     * @return true when the certificate is byte-identical to the one pinned at build time.
     */
    private fun matchesPinnedCertificate(error: SslError): Boolean {
        val pinned = BuildConfig.RELAY_CERT_SHA256.replace(":", "").lowercase()
        if (pinned.isEmpty()) return false

        val certificate = error.certificate ?: return false
        val encoded = try {
            certificate.x509Certificate?.encoded
        } catch (throwable: Throwable) {
            null
        } ?: return false

        val digest = MessageDigest.getInstance("SHA-256").digest(encoded)
        val hex = digest.joinToString("") { "%02x".format(it) }
        return hex == pinned
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && web.canGoBack()) {
            web.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private companion object {
        const val KEY_ZOOM = "textZoom"
    }
}
