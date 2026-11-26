package com.neckfors.bookshelf

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

private const val PICK = 1
private const val DOWNLOADS = "https://github.com/neckfors/bookshelf/releases/latest"

/** Shows the web app in a web view and does the things a web page can't. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private var full = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)
        val content = Content(applicationContext)
        web = WebView(this).apply {
            setBackgroundColor(getColor(R.color.background))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.textZoom = 100
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            addJavascriptInterface(Bridge(), "AndroidBridge")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    content.answer(request)

                // Only the app's own page is ever shown here.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == HOST) return false
                    browse(request.url)
                    return true
                }

                // Android may stop the page to free memory; start again instead of closing.
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    recreate()
                    return true
                }
            }
        }
        val frame = FrameLayout(this).apply { addView(web) }
        // Keeps the page clear of the status and navigation bars and the keyboard, except when reading.
        if (Build.VERSION.SDK_INT >= 30) frame.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(
                if (full) WindowInsets.Type.ime()
                else WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime()
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        } else frame.fitsSystemWindows = true
        if (Build.VERSION.SDK_INT >= 28) window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        setContentView(frame)
        web.loadUrl("https://$HOST/")
    }

    // These also tell the page when it is shown again, so it looks for new books and versions.
    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // An open sheet is closed first; otherwise Back goes back in the page, and then leaves the app.
        web.evaluateJavascript("window.closeOpenSheet?.() === true") { closed ->
            if (closed != "true") {
                if (web.canGoBack()) web.goBack() else finish()
            }
        }
    }

    override fun onWindowFocusChanged(focused: Boolean) {
        super.onWindowFocusChanged(focused)
        if (focused && full) showBars(false)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(request: Int, result: Int, data: Intent?) {
        if (request != PICK) return
        val tree = data?.data?.takeIf { result == RESULT_OK }
        if (tree != null) contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        picked(tree)
    }

    private fun picked(tree: Uri?) {
        val value = if (tree == null) "null" else org.json.JSONObject.quote(tree.toString())
        web.evaluateJavascript("window.folderPicked?.($value)", null)
    }

    private fun browse(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url))
        } catch (e: ActivityNotFoundException) {
            // No browser: nothing to open it with.
        }
    }

    /** While reading: no system bars, and the screen stays on. */
    private fun fullscreen(on: Boolean) {
        full = on
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        showBars(!on)
        window.decorView.requestApplyInsets()
    }

    @Suppress("DEPRECATION")
    private fun showBars(show: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) window.insetsController?.run {
            systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            if (show) show(WindowInsets.Type.systemBars()) else hide(WindowInsets.Type.systemBars())
        } else window.decorView.systemUiVisibility = if (show) 0 else View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
    }

    /** Called by js/native.js, on a thread of its own. */
    private inner class Bridge {
        @JavascriptInterface
        fun pickFolder() = runOnUiThread {
            try {
                startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), PICK)
            } catch (e: ActivityNotFoundException) {
                picked(null)
            }
        }

        @JavascriptInterface
        fun hasAccess(tree: String) =
            contentResolver.persistedUriPermissions.any { it.isReadPermission && it.uri.toString() == tree }

        @JavascriptInterface
        fun setFullscreen(on: Boolean) = runOnUiThread { fullscreen(on) }

        @JavascriptInterface
        @Suppress("DEPRECATION")
        fun versionCode(): Int = packageManager.getPackageInfo(packageName, 0).let {
            if (Build.VERSION.SDK_INT >= 28) it.longVersionCode.toInt() else it.versionCode
        }

        @JavascriptInterface
        fun versionName(): String = packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()

        @JavascriptInterface
        fun openDownloads() = runOnUiThread { browse(Uri.parse(DOWNLOADS)) }
    }
}
