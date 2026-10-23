// Detects a book's format and turns it into a common "book" object:
//   { format, metadata, toc, sections[], rendition, resolveHref(), getCover(), destroy() }
// Each section is either reflowable HTML (`load()` → URL), a fixed-layout HTML page
// (`fixed: true`), or a PDF page drawn by `render()`.
// EPUB / MOBI / AZW3 / FB2 / CBZ parsing is done by the vendored foliate-js parsers.

export class UnsupportedError extends Error {}

const ext = name => {
    const lower = (name ?? '').toLowerCase()
    if (lower.endsWith('.fb2.zip')) return 'fbz'
    return lower.match(/\.([a-z0-9]+)$/)?.[1] ?? ''
}

const bytes = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer())
const ascii = arr => String.fromCharCode(...arr)

const isZip = arr => arr[0] === 0x50 && arr[1] === 0x4b && arr[2] === 0x03 && arr[3] === 0x04

export const sniffFormat = async file => {
    const head = await bytes(file, 0, 1024)
    const e = ext(file.name)
    const headText = ascii(head)
    if (headText.includes('%PDF-')) return 'pdf'
    if (isZip(head)) {
        if (e === 'cbz') return 'cbz'
        if (e === 'fbz') return 'fbz'
        if (e === 'docx' || e === 'odt') return 'unsupported:' + e
        return 'zip' // decided after listing entries
    }
    const type = ascii(head.slice(60, 68))
    if (type === 'BOOKMOBI' || type === 'TEXtREAd') return 'mobi'
    if (headText.startsWith('\xeaDRMION') || headText.startsWith('CONT')) return 'unsupported:kfx'
    if (e === 'fb2' || /<FictionBook/i.test(headText)) return 'fb2'
    if (['html', 'htm', 'xhtml', 'xht'].includes(e)) return 'html'
    if (['md', 'markdown'].includes(e)) return 'md'
    if (['txt', 'text'].includes(e)) return 'txt'
    if (/^\s*(<\?xml[^>]*>\s*)?(<!doctype html|<html)/i.test(headText)) return 'html'
    if (['azw', 'azw3', 'mobi', 'prc', 'pdb', 'kf8'].includes(e)) return 'unsupported:' + e
    // Last resort: treat anything that decodes as text as plain text.
    if (!head.some(b => b === 0)) return 'txt'
    return 'unsupported:' + (e || 'unknown')
}

const makeZipLoader = async file => {
    const { configure, ZipReader, BlobReader, TextWriter, BlobWriter } =
        await import('../vendor/foliate/vendor/zip.js')
    configure({ useWebWorkers: false })
    const reader = new ZipReader(new BlobReader(file))
    const entries = await reader.getEntries()
    const map = new Map(entries.map(entry => [entry.filename, entry]))
    const load = f => (name, ...args) => map.has(name) ? f(map.get(name), ...args) : null
    const loadText = load(entry => entry.getData(new TextWriter()))
    const loadBlob = load((entry, type) => entry.getData(new BlobWriter(type)))
    const getSize = name => map.get(name)?.uncompressedSize ?? 0
    return { entries, loadText, loadBlob, getSize }
}

const IMAGE_RE = /\.(jpe?g|png|gif|bmp|webp|svg|avif|jxl)$/i

// Normalises foliate's metadata shapes (strings, language maps, contributor objects).
const langString = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    if (Array.isArray(x)) return x.map(langString).filter(Boolean).join(', ')
    if (x.name) return langString(x.name)
    const values = Object.values(x)
    return typeof values[0] === 'string' ? values[0] : ''
}
export const bookTitle = (book, fallback) =>
    langString(book.metadata?.title).trim() || fallback.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ')
export const bookAuthor = book => langString(book.metadata?.author).trim()

/**
 * Open a book file. `options.bookId` and `options.onProgress` are used by the PDF converter,
 * which caches its page analysis per book.
 */
export const openBook = async (file, options = {}) => {
    let format = await sniffFormat(file)
    if (format.startsWith('unsupported:')) {
        const what = format.slice(12)
        if (what === 'kfx') throw new UnsupportedError('KFX (Kindle 8+) files are not supported. Convert them to AZW3 or EPUB with Calibre first.')
        if (['azw', 'azw3', 'mobi', 'prc', 'kf8'].includes(what))
            throw new UnsupportedError('This Kindle file could not be read. It may be DRM-protected.')
        throw new UnsupportedError(`“.${what}” files are not supported.`)
    }
    let book
    if (format === 'zip' || format === 'cbz' || format === 'fbz') {
        const loader = await makeZipLoader(file)
        const names = loader.entries.map(e => e.filename)
        if (format === 'zip') {
            if (names.includes('META-INF/container.xml')) format = 'epub'
            else if (names.some(n => n.toLowerCase().endsWith('.fb2'))) format = 'fbz'
            else if (names.some(n => IMAGE_RE.test(n))) format = 'cbz'
            else throw new UnsupportedError('This archive does not contain a book.')
        }
        if (format === 'epub') {
            const { EPUB } = await import('../vendor/foliate/epub.js')
            book = await new EPUB(loader).init()
        } else if (format === 'fbz') {
            const { makeFB2 } = await import('../vendor/foliate/fb2.js')
            const entry = loader.entries.find(e => e.filename.toLowerCase().endsWith('.fb2')) ?? loader.entries[0]
            book = await makeFB2(await loader.loadBlob(entry.filename))
        } else {
            const { makeComicBook } = await import('../vendor/foliate/comic-book.js')
            book = makeComicBook(loader, file)
        }
    } else if (format === 'mobi') {
        const { MOBI } = await import('../vendor/foliate/mobi.js')
        const fflate = await import('../vendor/foliate/vendor/fflate.js')
        try {
            book = await new MOBI({ unzlib: fflate.unzlibSync }).open(file)
        } catch (e) {
            console.error(e)
            throw new UnsupportedError('This Kindle file could not be read. It may be DRM-protected.')
        }
        format = book.rendition?.layout ? 'azw3' : 'mobi'
        if (ext(file.name) === 'azw') format = 'azw'
    } else if (format === 'fb2') {
        const { makeFB2 } = await import('../vendor/foliate/fb2.js')
        book = await makeFB2(file)
    } else if (format === 'pdf') {
        const { makePDFBook } = await import('./pdf.js')
        book = await makePDFBook(file, options)
    } else {
        const { makeTextBook } = await import('./text.js')
        book = await makeTextBook(file, format)
    }
    book.format = format
    book.sections = book.sections ?? []
    book.toc = book.toc ?? []
    const fixedLayout = book.rendition?.layout === 'pre-paginated'
    for (const s of book.sections) if (fixedLayout && s.fixed == null && !s.render) s.fixed = true
    return book
}

// A small cover image for the library grid (so it stays fast with hundreds of books).
export const makeThumbnail = async (blob, maxW = 360, maxH = 540) => {
    if (!blob) return null
    try {
        const bitmap = await createImageBitmap(blob)
        const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height)
        const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        bitmap.close()
        return await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })
    } catch {
        // createImageBitmap cannot decode SVG covers; draw them through an <img> instead.
        try {
            const url = URL.createObjectURL(blob)
            const img = new Image()
            img.src = url
            await img.decode()
            const w = img.naturalWidth || 600, h = img.naturalHeight || 900
            const scale = Math.min(maxW / w, maxH / h)
            const canvas = document.createElement('canvas')
            canvas.width = Math.round(w * scale)
            canvas.height = Math.round(h * scale)
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
            URL.revokeObjectURL(url)
            return await new Promise(r => canvas.toBlob(r, 'image/webp', 0.85))
        } catch {
            return null
        }
    }
}
