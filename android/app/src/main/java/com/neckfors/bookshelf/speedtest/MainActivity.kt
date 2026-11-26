package com.neckfors.bookshelf.speedtest

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.concurrent.thread

class MainActivity : Activity() {
    private lateinit var choose: Button
    private lateinit var again: Button
    private lateinit var copy: Button
    private lateinit var status: TextView
    private val covers = mutableListOf<Cover?>()
    private val adapter = CoverAdapter()
    private var running = false

    private val prefs by lazy { getSharedPreferences("test", MODE_PRIVATE) }
    private val folder get() = prefs.getString("folder", null)?.let(Uri::parse)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val space = dp(12)
        choose = button("Choose book folder") {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), 1)
        }
        again = button("Run again") { folder?.let(::run) }
        copy = button("Copy report") {
            getSystemService(ClipboardManager::class.java)
                .setPrimaryClip(ClipData.newPlainText("Speed test", status.text))
        }
        status = TextView(this).apply {
            textSize = 16f
            setTextIsSelectable(true)
            text = "Choose the folder with your books. The test finds them and draws every front page."
        }
        val buttons = LinearLayout(this).apply { addView(choose); addView(again); addView(copy) }
        val grid = GridView(this).apply {
            numColumns = GridView.AUTO_FIT
            columnWidth = dp(110)
            horizontalSpacing = space
            verticalSpacing = space
            adapter = this@MainActivity.adapter
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(space, space, space, space)
            addView(buttons)
            addView(ScrollView(context).apply { addView(status) }, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(grid, LinearLayout.LayoutParams(-1, 0, 1f))
        }
        // Keeps the content clear of the status and navigation bars.
        if (Build.VERSION.SDK_INT >= 30) root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            view.setPadding(bars.left + space, bars.top + space, bars.right + space, bars.bottom + space)
            insets
        }
        setContentView(root)
        update()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(request: Int, result: Int, data: Intent?) {
        val tree = data?.data
        if (result != RESULT_OK || tree == null) return
        contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        prefs.edit().putString("folder", tree.toString()).apply()
        run(tree)
    }

    private fun run(tree: Uri) {
        if (running) return
        running = true
        update()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        covers.clear()
        adapter.notifyDataSetChanged()
        thread {
            val report = StringBuilder("Bookshelf speed test 1.0\n")
            report.append("${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}, ")
            report.append("${Runtime.getRuntime().availableProcessors()} cores\n")
            try {
                test(tree, report)
                report.append("Done.")
            } catch (e: Throwable) {
                report.append("The test stopped: $e")
            }
            runOnUiThread {
                status.text = report
                running = false
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                update()
            }
        }
    }

    private fun test(tree: Uri, report: StringBuilder) {
        show("Looking for books…")
        var at = System.nanoTime()
        val found = findBooks(contentResolver, tree)
        val findMs = since(at)
        val books = found.books
        report.append("Found ${books.size} books in ${found.folders} folders in ${seconds(findMs)}\n")
        if (books.isEmpty()) return
        report.append("Average book ${number(books.sumOf { it.size } / books.size / 1e6)} MB\n")
        runOnUiThread {
            repeat(books.size) { covers.add(null) }
            adapter.notifyDataSetChanged()
        }
        val target = File(cacheDir, "covers").apply { mkdirs() }
        // Every other book in each round, so that neither round gains from the other having read the files.
        var totalMs = 0.0
        for ((round, atOnce) in listOf(1, 4).withIndex()) {
            val mine = books.indices.filter { it % 2 == round }
            if (mine.isEmpty()) continue
            val pool = Executors.newFixedThreadPool(atOnce)
            val done = mutableListOf<Steps>()
            val failures = mutableListOf<String>()
            var count = 0
            at = System.nanoTime()
            try {
                pool.invokeAll(mine.map { i ->
                    Callable {
                        val result = runCatching { makeCover(contentResolver, books[i], File(target, "$i.jpg")) }
                        synchronized(done) {
                            result.onSuccess { done.add(it.steps) }
                            result.onFailure { failures.add("${it.javaClass.simpleName}: ${it.message}") }
                            val now = ++count
                            runOnUiThread {
                                covers[i] = result.getOrNull()
                                adapter.notifyDataSetChanged()
                                status.text = "Drawing covers, $atOnce at a time: $now of ${mine.size}"
                            }
                        }
                    }
                })
            } finally {
                pool.shutdown()
            }
            val ms = since(at)
            totalMs += ms
            report.append("\n$atOnce at a time: ${done.size} covers in ${seconds(ms)}")
            report.append(" (${number(done.size / (ms / 1000))} a second)\n")
            if (done.isNotEmpty()) {
                fun mean(step: (Steps) -> Double) = (done.sumOf(step) / done.size).toInt()
                report.append("Per book: opening ${mean { it.open }} ms, reading ${mean { it.read }} ms, ")
                report.append("drawing ${mean { it.draw }} ms, saving ${mean { it.save }} ms\n")
            }
            if (failures.isNotEmpty()) {
                report.append("Failed: ${failures.size}\n")
                failures.distinct().take(3).forEach { report.append("  $it\n") }
            }
        }
        report.append("\nAll ${books.size} books, found and drawn: ${seconds(findMs + totalMs)}\n")
    }

    private fun show(text: String) = runOnUiThread { status.text = text }

    private fun update() {
        choose.isEnabled = !running
        again.isEnabled = !running && folder != null
        copy.isEnabled = !running
    }

    private fun number(value: Double) = String.format(Locale.US, "%.1f", value)
    private fun seconds(ms: Double) = "${number(ms / 1000)} s"
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun button(label: String, click: () -> Unit) =
        Button(this).apply { text = label; setOnClickListener { click() } }

    private inner class CoverAdapter : BaseAdapter() {
        override fun getCount() = covers.size
        override fun getItem(position: Int) = covers[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, old: View?, parent: ViewGroup): View {
            val view = old as? ImageView ?: ImageView(this@MainActivity).apply {
                layoutParams = ViewGroup.LayoutParams(-1, dp(165))
                scaleType = ImageView.ScaleType.FIT_CENTER
                setBackgroundColor(0xff2a2a2a.toInt())
            }
            view.setImageBitmap(covers[position]?.small)
            return view
        }
    }
}
