package com.neckfors.bookshelf.speedtest

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.File
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class Book(val uri: Uri, val path: String, val size: Long)

class Found(val books: List<Book>, val folders: Int)

/** Walks the chosen folder. One query gives a whole folder with names and sizes. */
fun findBooks(resolver: ContentResolver, tree: Uri): Found {
    val books = mutableListOf<Book>()
    val waiting = ArrayDeque(listOf(DocumentsContract.getTreeDocumentId(tree) to ""))
    var folders = 0
    val columns = arrayOf(
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
        Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED,
    )
    while (waiting.isNotEmpty()) {
        val (id, path) = waiting.removeFirst()
        folders++
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
        val cursor = resolver.query(children, columns, null, null, null) ?: error("The folder could not be read")
        cursor.use {
            while (it.moveToNext()) {
                val name = it.getString(1) ?: continue
                if (name.startsWith(".")) continue
                val full = if (path.isEmpty()) name else "$path/$name"
                if (it.getString(2) == Document.MIME_TYPE_DIR) waiting.add(it.getString(0) to full)
                else if (name.endsWith(".pdf", ignoreCase = true)) {
                    books.add(Book(DocumentsContract.buildDocumentUriUsingTree(tree, it.getString(0)), full, it.getLong(3)))
                }
            }
        }
    }
    books.sortWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.path })
    return Found(books, folders)
}

/** Milliseconds spent on each step of one cover. */
class Steps(var open: Double = 0.0, var read: Double = 0.0, var draw: Double = 0.0, var save: Double = 0.0)

class Cover(val small: Bitmap, val steps: Steps)

private const val WIDTH = 460
private const val HEIGHT = 690

fun since(start: Long) = (System.nanoTime() - start) / 1e6

/** Draws the front page with Android's own PDF engine and saves it, as the full app would. */
fun makeCover(resolver: ContentResolver, book: Book, target: File): Cover {
    val steps = Steps()
    var at = System.nanoTime()
    val file = resolver.openFileDescriptor(book.uri, "r") ?: error("The file could not be opened")
    steps.open = since(at)
    at = System.nanoTime()
    // The renderer closes the file, except when it can't be created.
    val renderer = try {
        PdfRenderer(file)
    } catch (e: Throwable) {
        file.close()
        throw e
    }
    val picture = renderer.use {
        it.openPage(0).use { page ->
            steps.read = since(at)
            at = System.nanoTime()
            val scale = min(WIDTH.toDouble() / page.width, HEIGHT.toDouble() / page.height)
            val bitmap = Bitmap.createBitmap(
                max(1, (page.width * scale).roundToInt()), max(1, (page.height * scale).roundToInt()),
                Bitmap.Config.ARGB_8888,
            )
            bitmap.eraseColor(Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            steps.draw = since(at)
            bitmap
        }
    }
    at = System.nanoTime()
    target.outputStream().use { picture.compress(Bitmap.CompressFormat.JPEG, 85, it) }
    steps.save = since(at)
    val small = Bitmap.createScaledBitmap(picture, max(1, picture.width / 2), max(1, picture.height / 2), true)
    if (small !== picture) picture.recycle()
    return Cover(small, steps)
}
