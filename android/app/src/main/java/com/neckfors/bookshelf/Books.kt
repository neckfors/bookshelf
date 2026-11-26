package com.neckfors.bookshelf

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class Book(val uri: Uri, val path: String, val size: Long, val modified: Long)

/** The books in the folder the user has chosen. */
class Books(private val resolver: ContentResolver) {
    private val known = ConcurrentHashMap<String, Map<String, Book>>()

    /** Walks the folder. One query gives a whole folder with names, sizes and dates. */
    fun find(tree: Uri): List<Book> {
        val books = mutableListOf<Book>()
        val waiting = ArrayDeque(listOf(DocumentsContract.getTreeDocumentId(tree) to ""))
        val columns = arrayOf(
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED,
        )
        while (waiting.isNotEmpty()) {
            val (id, path) = waiting.removeFirst()
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
            // A folder that can't be read must fail the whole search, or its books would be forgotten.
            val cursor = resolver.query(children, columns, null, null, null)
                ?: throw IOException("The folder could not be read")
            cursor.use {
                while (it.moveToNext()) {
                    val name = it.getString(1) ?: continue
                    if (name.startsWith(".")) continue
                    val full = if (path.isEmpty()) name else "$path/$name"
                    if (it.getString(2) == Document.MIME_TYPE_DIR) waiting.add(it.getString(0) to full)
                    else if (name.endsWith(".pdf", ignoreCase = true)) {
                        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, it.getString(0))
                        books.add(Book(uri, full, it.getLong(3), it.getLong(4)))
                    }
                }
            }
        }
        known[tree.toString()] = books.associateBy { it.path }
        return books
    }

    private fun open(tree: Uri, path: String): ParcelFileDescriptor {
        // Right after a start, a saved book can be asked for before the folder has been searched.
        val books = known[tree.toString()] ?: find(tree).associateBy { it.path }
        val book = books[path] ?: throw FileNotFoundException(path)
        return resolver.openFileDescriptor(book.uri, "r") ?: throw FileNotFoundException(path)
    }

    /** A part of a file, for the reader. */
    fun read(tree: Uri, path: String, start: Long, end: Long): ByteArray =
        open(tree, path).use { file ->
            val buffer = ByteBuffer.allocate((end - start).toInt())
            FileInputStream(file.fileDescriptor).channel.use { channel ->
                while (buffer.hasRemaining()) {
                    if (channel.read(buffer, start + buffer.position()) < 0) throw IOException("The file is shorter")
                }
            }
            buffer.array()
        }

    /**
     * One page as a JPEG that fits in the given size, drawn with Android's own PDF engine.
     * Empty if the file is not a PDF that can be shown (broken or locked).
     */
    fun page(tree: Uri, path: String, number: Int, width: Int, height: Int): ByteArray {
        val file = open(tree, path)
        // The renderer closes the file, except when it can't be created.
        val renderer = try {
            PdfRenderer(file)
        } catch (e: Exception) {
            file.close()
            return ByteArray(0)
        }
        val picture = try {
            renderer.use {
                it.openPage((number - 1).coerceIn(0, it.pageCount - 1)).use { page ->
                    val scale = min(width.toDouble() / page.width, height.toDouble() / page.height)
                    val bitmap = Bitmap.createBitmap(
                        max(1, (page.width * scale).roundToInt()), max(1, (page.height * scale).roundToInt()),
                        Bitmap.Config.ARGB_8888,
                    )
                    bitmap.eraseColor(Color.WHITE)
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    bitmap
                }
            }
        } catch (e: Exception) {
            return ByteArray(0)
        }
        val out = ByteArrayOutputStream()
        picture.compress(Bitmap.CompressFormat.JPEG, 90, out)
        picture.recycle()
        return out.toByteArray()
    }
}
