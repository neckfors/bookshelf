# Bookshelf

An installable web app for browsing and reading your own PDF books, made for a tablet.
The books stay on your device; nothing is uploaded.

**Open it:** https://neckfors.github.io/bookshelf/

## Browsing
- Front covers only, in equal tiles. The whole cover is shown, with a blurred frame filling the gaps.
  White scan borders are trimmed. A book with a blank, locked or broken first page gets a title cover.
- Folders with book counts, favorite folders and favorite books.
- Search in file and folder names (accents don't matter), everywhere or in the open folder.
- 2 to 10 columns, set separately for portrait and landscape.
- Covers are saved, so the library opens at once. New, changed and removed files are noticed
  automatically (by size and date). You can also refresh all covers.
- Covers are drawn with PDFium (the engine in Chrome's own PDF viewer), which goes straight to the
  front page and reads only a few small parts of each file. A scanned front page (one JPEG picture) is
  handed to the browser's own, much faster picture decoder.
- Getting data from a file is usually the slow part on Android, so 16 books are fetched at the same time.
  The start and end of each file are read in advance, side by side, so one visit is normally enough.
  Up to 4 background workers turn the data into finished tiles, without holding up scrolling.
- Books are listed from their file names first, so they appear right away; checking for changed files
  happens afterwards. Covers are made in the order you look at them:
  the ones on screen from the top, then the ones below. Scroll further and the work moves with you.
  Settings shows how long finding books, making covers and opening a book took, step by step.
  **Test file speed** measures how fast the device hands over files and gives a report you can copy.

## Reading
- Fullscreen, portrait and landscape. Swipe or tap the sides to turn; tap the middle for the menu.
- Pinch to zoom. While zoomed, drag to move around.
- Settings saved per book: single page, two pages, or two pages with the cover alone (default);
  single page in portrait; right to left; trim white margins; normal, sepia or dark pages;
  which page (and which half) is the cover.
- Bookmarks, table of contents, page slider and "Go to page".
- A picture of the page you left (or the cover) shows at once while the book opens, and the last
  book you closed reopens instantly.
- A book opens where you left it. If the last page was showing when you left, it starts from the beginning.
  Turning past the last page closes the book.

## Using it
Open the app in Chrome, install it from the browser menu, then tap **Choose folder** and pick the
folder with your PDFs (subfolders are included). If Chrome asks for access again later, tap **Allow**.

The app must be served over HTTPS (or from `localhost`). The first start needs a network connection to
fetch [pdf.js](https://mozilla.github.io/pdf.js/) (for reading) and
[PDFium](https://www.npmjs.com/package/@embedpdf/pdfium) (for covers, about 5 MB) from jsDelivr; they are then
saved on the device.
Settings and favorites are stored in the browser, so clearing the site's data removes them.

## Files
| File | Contents |
| --- | --- |
| `js/app.js` | Browse view, folders, favorites, search |
| `js/reader.js`, `js/gestures.js` | Reader and touch handling |
| `js/library.js` | Folder scanning and the cover queue |
| `js/covers.js`, `js/coverworker.js`, `js/scan.js`, `js/tile.js` | Making covers: fetching, drawing, scanned pictures, tiles |
| `js/speedtest.js` | File speed test |
| `js/db.js`, `js/pdf.js`, `js/update.js`, `js/util.js` | Storage, PDF loading, updates, helpers |
| `sw.js` | Offline use. Raise `VERSION` for each release |

To run it locally: `py -3 -m http.server 8123`, then open `http://localhost:8123`.
