# Shelf — book reader extension for Chromium

Drop a book on the page and it is converted to HTML, saved in a local library (IndexedDB,
nothing leaves the browser) and opened in a paginated reader.

## Install

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`…).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. Click the Shelf icon in the toolbar to open the reader in its own tab.

## Or use it as a web app (needed for Yomitan and other dictionary extensions)

Chrome never lets one extension run inside another extension's pages, so pop-up dictionaries
such as Yomitan can't work on the extension version. The same folder also works as an
installable web app on any static host, and there Yomitan's Shift-hover lookups work.

GitHub Pages:

1. Create a GitHub repository and push this folder to it.
2. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch**,
   pick the branch and `/ (root)`, and save.
3. Open `https://<user>.github.io/<repo>/` (it redirects to `reader.html`).
4. Click the install icon in the address bar (or ⋮ → *Cast, save and share → Install page as app*).
   Shelf then gets its own window, works offline, and appears under "Open with" for book files.

The web app keeps its own library (browser storage is per site), so books added to the
extension have to be added again there.

## Formats

EPUB, KEPUB, AZW3/KF8, MOBI, AZW, PRC, PDF, FB2, FBZ (FB2.ZIP), CBZ, TXT, HTML and Markdown.
DRM-protected files and KFX can't be read (convert them with Calibre first).

## How pagination works

* **Reflowable text** is split into pages in real time with CSS columns, sized to the window,
  zoom, font, line spacing and margins. Any change re-splits immediately and keeps your place.
* **Figures, charts, tables, SVG, maths and image+caption groups** are never split across pages.
  If one is a bit too big for a page it is scaled to fit; if it's far too big (a very long table)
  it is allowed to break so it stays readable. A short section made of charts/tables and notes
  is kept together as one page.
* **PDFs** are analysed once when added. Pages of plain prose are reflowed (paragraphs continue
  across the original page breaks, running headers and page numbers are removed). Pages with
  pictures, charts/diagrams, tables, maths, footnotes/citations, rotated text or title layouts
  keep their **original page construction** and are shown as the real page (with selectable text).
  The *PDF layout* setting switches between Smart, Original pages and Reflow all.
* **Fixed-layout** EPUB/KF8 and comics are shown page by page, two at a time on wide screens.

## Keys

`←/→`, `PageUp/PageDown`, `Space` turn pages · `T` contents · `A` appearance · `F` full screen ·
`+`/`-`/`0` zoom · `Esc` back. Click the left/right edge to turn pages, the middle to hide the bars.

## Development

`python .claude/devserver.py 8766` serves the folder so `http://localhost:8766/reader.html`
works in a normal tab (it behaves the same as the extension page, minus the toolbar button).

Third-party code in `vendor/`: [foliate-js](https://github.com/johnfactotum/foliate-js) parsers
(MIT) and [pdf.js](https://mozilla.github.io/pdf.js/) 4.10.38 (Apache-2.0).
