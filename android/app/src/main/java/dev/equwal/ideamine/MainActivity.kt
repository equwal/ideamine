package dev.equwal.ideamine

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback

/**
 * A window on the ideamine dashboard. The dashboard itself is the app: this activity only keeps the
 * address of the server, shows the page, and gives a shared text to the composer of the page.
 *
 * The server answers on a private network (WireGuard), so the page is not on the internet and the
 * app talks to it over plain HTTP. network_security_config.xml allows that for those names only.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var errorView: LinearLayout
    private lateinit var errorText: TextView

    private val settings by lazy { getSharedPreferences("ideamine", MODE_PRIVATE) }

    private var server: String
        get() = settings.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(value) = settings.edit().putString("server", clean(value)).apply()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        errorView = findViewById(R.id.error)
        errorText = findViewById(R.id.error_text)
        findViewById<Button>(R.id.retry).setOnClickListener { open(urlFor(intent) ?: server) }
        findViewById<Button>(R.id.change_server).setOnClickListener { askForServer() }

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.databaseEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == Uri.parse(server).host) return false // the dashboard stays in the app
                startActivity(Intent(Intent.ACTION_VIEW, url)) // another site opens in the browser
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                showError(getString(R.string.no_server, server))
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (errorView.visibility != View.VISIBLE) web.visibility = View.VISIBLE
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        open(urlFor(intent) ?: server)
    }

    /** A share or the shortcut while the app runs: the page opens again for it. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        urlFor(intent)?.let { open(it) }
    }

    /**
     * The address of the dashboard for this intent: a shared text goes to the composer of the page,
     * and the "New idea" shortcut opens the composer empty. Null means: only show the board.
     */
    private fun urlFor(intent: Intent?): String? {
        val address = Uri.parse(server).buildUpon()
        if (intent?.action == NEW_IDEA) return address.appendQueryParameter("new", "1").build().toString()
        if (intent?.action != Intent.ACTION_SEND) return null
        val parts = listOfNotNull(
            intent.getStringExtra(Intent.EXTRA_SUBJECT),
            intent.getStringExtra(Intent.EXTRA_TEXT),
        )
        if (parts.isEmpty()) return null
        return address.appendQueryParameter("text", parts.joinToString("\n")).build().toString()
    }

    private fun open(url: String) {
        errorView.visibility = View.GONE
        web.loadUrl(url)
    }

    private fun showError(message: String) {
        errorText.text = message
        errorView.visibility = View.VISIBLE
        web.visibility = View.GONE
    }

    /** The address of the server. Each device on the private network has its own. */
    private fun askForServer() {
        val input = EditText(this).apply {
            setText(server)
            setSingleLine()
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.server_title)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                server = input.text.toString()
                open(server)
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    companion object {
        const val DEFAULT_SERVER = "http://mem.equwal.com/"
        const val NEW_IDEA = "dev.equwal.ideamine.NEW_IDEA"

        /** An address with a scheme and a slash at the end, so that a shared text can go after it. */
        fun clean(raw: String): String {
            val trimmed = raw.trim().ifEmpty { DEFAULT_SERVER }
            val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) trimmed else "http://$trimmed"
            return if (withScheme.endsWith("/")) withScheme else "$withScheme/"
        }
    }
}
