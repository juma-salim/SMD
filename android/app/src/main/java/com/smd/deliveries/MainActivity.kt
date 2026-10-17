package com.smd.deliveries

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Thin native shell around the hosted SMD web app.
 * All accounts, sessions and data stay on the server; the app only displays it.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorBox: View
    private lateinit var errorText: TextView

    private val server: Uri = Uri.parse(BuildConfig.SERVER_URL.trim())
    private var lastUrl: String = server.toString()

    private var geoCallback: GeolocationPermissions.Callback? = null
    private var geoOrigin: String? = null

    private val locationPermission =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            geoCallback?.invoke(geoOrigin.orEmpty(), result.values.any { it }, false)
            geoCallback = null
        }

    // Lets the page's <input type="file"> open the phone's photo/file picker (used for shipper ID photos).
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val filePicker =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
            fileCallback = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        progress = findViewById(R.id.progress)
        errorBox = findViewById(R.id.errorBox)
        errorText = findViewById(R.id.errorText)
        findViewById<Button>(R.id.retry).setOnClickListener {
            errorBox.visibility = View.GONE
            web.visibility = View.VISIBLE
            web.loadUrl(lastUrl)
        }

        val problem = configProblem()
        if (problem != null) {
            showError(problem, withRetry = false)
            return
        }

        setupWebView()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) {
                    web.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(server.toString())
        }
    }

    /** Refuse to run against an unsafe or unset server address. */
    private fun configProblem(): String? {
        val url = BuildConfig.SERVER_URL.trim()
        if (url.contains("YOUR-DOMAIN", ignoreCase = true)) {
            return "Server address not set.\n\nOpen gradle.properties, set SMD_RELEASE_URL to your https address, and rebuild."
        }
        val scheme = server.scheme?.lowercase()
        val okScheme = scheme == "https" || (BuildConfig.DEBUG && scheme == "http")
        if (server.host.isNullOrEmpty() || !okScheme) {
            return "The server address must start with https://\n\nCurrent value: $url"
        }
        return null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        web.settings.apply {
            javaScriptEnabled = true          // the SMD web app needs it
            domStorageEnabled = true
            allowFileAccess = false           // the page can never read local files
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            setSupportMultipleWindows(false)
            setGeolocationEnabled(true)
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (sameOrigin(url)) return false
                openExternally(url)   // Google Maps, phone, email: hand off to the right app
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (url != null && sameOrigin(Uri.parse(url))) lastUrl = url
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    showError(
                        "Can't reach the SMD server.\n\nTried: ${request.url}\nReason: ${error.description}\n\n" +
                            "Make sure the server is running (npm start) and this address is correct, then tap Try again.",
                        withRetry = true
                    )
                }
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (request.isForMainFrame && errorResponse.statusCode >= 500) {
                    showError("The SMD server is having problems.\n\nPlease try again in a moment.", withRetry = true)
                }
            }
            // SSL errors are deliberately NOT overridden: invalid certificates are always rejected.
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            // Powers the "Share my current location" pin button, for our own server only.
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (!sameOrigin(Uri.parse(origin))) {
                    callback.invoke(origin, false, false)
                    return
                }
                val granted = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED ||
                    ContextCompat.checkSelfPermission(
                        this@MainActivity, Manifest.permission.ACCESS_COARSE_LOCATION
                    ) == PackageManager.PERMISSION_GRANTED
                if (granted) {
                    callback.invoke(origin, true, false)
                } else {
                    geoCallback = callback
                    geoOrigin = origin
                    locationPermission.launch(
                        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
                    )
                }
            }

            override fun onGeolocationPermissionsHidePrompt() {
                geoCallback = null
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                // Only our own server's pages may open the picker.
                if (!sameOrigin(Uri.parse(view.url ?: ""))) {
                    callback.onReceiveValue(null)
                    return true
                }
                fileCallback?.onReceiveValue(null)   // cancel any picker that is still pending
                fileCallback = callback
                return try {
                    filePicker.launch(params.createIntent())
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    callback.onReceiveValue(null)
                    true
                }
            }
        }
    }

    private fun port(u: Uri): Int = if (u.port != -1) u.port else if (u.scheme.equals("https", true)) 443 else 80

    private fun sameOrigin(u: Uri): Boolean =
        u.scheme.equals(server.scheme, ignoreCase = true) &&
            u.host.equals(server.host, ignoreCase = true) &&
            port(u) == port(server)

    private fun openExternally(u: Uri) {
        val scheme = u.scheme?.lowercase()
        if (scheme in setOf("http", "https", "geo", "tel", "mailto")) {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE))
            } catch (_: ActivityNotFoundException) {
                // no app can handle it: ignore
            }
        }
    }

    private fun showError(message: String, withRetry: Boolean) {
        errorText.text = message
        findViewById<Button>(R.id.retry).visibility = if (withRetry) View.VISIBLE else View.GONE
        errorBox.visibility = View.VISIBLE
        web.visibility = View.INVISIBLE
        progress.visibility = View.GONE
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) web.onResume()
    }

    override fun onPause() {
        if (::web.isInitialized) {
            web.onPause()
            CookieManager.getInstance().flush()   // persist the login session
        }
        super.onPause()
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }
}
