package com.neckfors.bookshelf

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

const val HOST = "appassets.androidplatform.net"
private const val CDN = "cdn.jsdelivr.net"

/**
 * Answers the web view's requests: the web app's own files from inside the APK, the books from the
 * chosen folder, and the PDF reader's code, which is downloaded once and then kept.
 */
class Content(private val context: Context) {
    private val books = Books(context.contentResolver)
    // Four at a time was clearly faster than one on the tablet.
    private val pages = Executors.newFixedThreadPool(4)
    private val others = Executors.newFixedThreadPool(4)
    // The open book has its own, so covers being made never hold it up.
    private val reader = Executors.newSingleThreadExecutor()

    fun answer(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        val path = url.path.orEmpty()
        return when {
            url.host == HOST && path.startsWith("/native/") -> native(url)
            url.host == HOST -> asset(path.trimStart('/').ifEmpty { "index.html" })
            url.host == CDN && path.startsWith("/npm/") -> kept(url)
            else -> null
        }
    }

    private fun native(url: Uri): WebResourceResponse {
        fun text(name: String) = url.getQueryParameter(name) ?: ""
        fun number(name: String) = text(name).toLong()
        val tree = Uri.parse(text("tree"))
        return when (url.lastPathSegment) {
            "list" -> later("application/json", others) {
                val list = JSONArray()
                for (book in books.find(tree)) {
                    list.put(JSONObject().put("path", book.path).put("size", book.size).put("mtime", book.modified))
                }
                list.toString().toByteArray()
            }
            "read" -> later("application/octet-stream", others) {
                books.read(tree, text("path"), number("start"), number("end"))
            }
            "size" -> later("application/json", reader) {
                val size = books.size(tree, text("path"), number("page").toInt())
                JSONObject().put("count", size[0]).put("width", size[1]).put("height", size[2]).toString().toByteArray()
            }
            "view" -> later("image/jpeg", reader) {
                books.view(tree, text("path"), number("page").toInt(), number("w").toInt(), number("h").toInt())
            }
            "page" -> later("image/jpeg", pages) {
                books.page(tree, text("path"), number("page").toInt(), number("w").toInt(), number("h").toInt())
            }
            else -> missing()
        }
    }

    /**
     * The web view asks for one thing at a time, so the work is only started here. The answer is read
     * when it is ready, which lets several be on the way at once.
     */
    private fun later(type: String, on: ExecutorService, work: () -> ByteArray) =
        response(type, Later(on.submit(Callable { work() })))

    private fun asset(path: String): WebResourceResponse = try {
        response(type(path), context.assets.open("web/$path"))
    } catch (e: IOException) {
        missing()
    }

    private fun kept(url: Uri): WebResourceResponse {
        val path = url.path.orEmpty()
        val file = File(File(context.filesDir, "cdn"), path.replace('/', '_'))
        return later(type(path), others) {
            if (!file.exists()) download(url.toString(), file)
            file.readBytes()
        }
    }

    private fun download(url: String, target: File) {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        try {
            if (connection.responseCode != 200) throw IOException("HTTP ${connection.responseCode}")
            target.parentFile?.mkdirs()
            // Saved under another name first, so a broken download is never kept.
            val part = File.createTempFile("part", null, target.parentFile)
            try {
                connection.inputStream.use { from -> part.outputStream().use { from.copyTo(it) } }
                if (!part.renameTo(target)) throw IOException("Could not save $url")
            } finally {
                part.delete()
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun type(path: String) = when (path.substringAfterLast('.')) {
        "html" -> "text/html"
        "css" -> "text/css"
        "js", "mjs" -> "text/javascript"
        "json", "webmanifest" -> "application/json"
        "png" -> "image/png"
        "wasm" -> "application/wasm"
        else -> "application/octet-stream"
    }

    private fun response(type: String, data: InputStream) = WebResourceResponse(type, null, data).apply {
        // The reader's code comes from another address than the page.
        responseHeaders = mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store")
    }

    private fun missing() = WebResourceResponse("text/plain", null, ByteArrayInputStream(ByteArray(0))).apply {
        setStatusCodeAndReasonPhrase(404, "Not found")
    }
}

private class Later(private val result: Future<ByteArray>) : InputStream() {
    private val data by lazy {
        try {
            ByteArrayInputStream(result.get())
        } catch (e: ExecutionException) {
            // Makes the page's request fail.
            throw IOException(e.cause)
        }
    }

    override fun read() = data.read()
    override fun read(target: ByteArray, offset: Int, length: Int) = data.read(target, offset, length)
}
