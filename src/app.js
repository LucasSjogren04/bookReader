import * as db from './db.js'
import { openBook, makeThumbnail, bookTitle, bookAuthor, UnsupportedError } from './formats.js'
import { Paginator } from './paginator.js'
import { settings, setSetting, onSettingChange, resetSettings } from './settings.js'

const $ = sel => document.querySelector(sel)
const $$ = sel => [...document.querySelectorAll(sel)]

const els = {
    libraryView: $('#library-view'),
    readerView: $('#reader-view'),
    grid: $('#grid'),
    empty: $('#empty-state'),
    search: $('#search'),
    sort: $('#sort'),
    fileInput: $('#file-input'),
    stage: $('#stage'),
    loading: $('#loading'),
    loadingText: $('#loading-text'),
    bookTitle: $('#book-title'),
    chapterTitle: $('#chapter-title'),
    progress: $('#progress'),
    pageLabel: $('#page-label'),
    toc: $('#toc'),
    tocPanel: $('#toc-panel'),
    settingsPanel: $('#settings-panel'),
    notePopup: $('#note-popup'),
    dropOverlay: $('#drop-overlay'),
    toasts: $('#toasts'),
}

// ---------------------------------------------------------------------------------------------
// Utilities

const toast = (message, { error = false, timeout = 3500 } = {}) => {
    const el = document.createElement('div')
    el.className = 'toast' + (error ? ' error' : '')
    el.textContent = message
    els.toasts.append(el)
    setTimeout(() => el.remove(), timeout)
}

const debounce = (fn, ms) => {
    let t
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

const hashFile = async file => {
    // Hash the first 4 MB + size + name: fast for big PDFs and unique enough for a personal library.
    const head = await file.slice(0, 4 * 1024 * 1024).arrayBuffer()
    const tail = await file.slice(Math.max(0, file.size - 65536)).arrayBuffer()
    const meta = new TextEncoder().encode(`${file.size}`)
    const data = new Uint8Array(head.byteLength + tail.byteLength + meta.byteLength)
    data.set(new Uint8Array(head), 0)
    data.set(new Uint8Array(tail), head.byteLength)
    data.set(meta, head.byteLength + tail.byteLength)
    const digest = await crypto.subtle.digest('SHA-256', data)
    return [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('')
}

const hue = str => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

const applyTheme = () => {
    document.documentElement.dataset.theme = settings.theme
}

const EPUB_NS = 'http://www.idpf.org/2007/ops'
const epubType = el => (el.getAttributeNS?.(EPUB_NS, 'type') || el.getAttribute?.('epub:type') || '')

// ---------------------------------------------------------------------------------------------
// Library

let coverURLs = []

const renderLibrary = async () => {
    const books = await db.listBooks()
    const q = els.search.value.trim().toLowerCase()
    const sort = els.sort.value
    const list = books
        .filter(b => !q || b.title.toLowerCase().includes(q) || (b.author ?? '').toLowerCase().includes(q))
        .sort((a, b) => {
            if (sort === 'title') return a.title.localeCompare(b.title)
            if (sort === 'author') return (a.author || '￿').localeCompare(b.author || '￿') || a.title.localeCompare(b.title)
            if (sort === 'added') return b.added - a.added
            return (b.lastOpened ?? b.added) - (a.lastOpened ?? a.added)
        })
    coverURLs.forEach(u => URL.revokeObjectURL(u))
    coverURLs = []
    els.empty.hidden = books.length > 0 || importing.size > 0
    const cards = list.map(book => {
        const card = document.createElement('div')
        card.className = 'card'
        card.tabIndex = 0
        card.dataset.id = book.id
        card.title = [book.title, book.author].filter(Boolean).join(' — ')
        const cover = document.createElement('div')
        cover.className = 'cover'
        if (book.cover) {
            const img = document.createElement('img')
            const url = URL.createObjectURL(book.cover)
            coverURLs.push(url)
            img.src = url
            img.alt = ''
            img.loading = 'lazy'
            cover.append(img)
        } else {
            const h = hue(book.title)
            cover.style.background = `linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 50% 26%))`
            const ph = document.createElement('div')
            ph.className = 'placeholder'
            const pt = document.createElement('div'); pt.className = 'pt'; pt.textContent = book.title
            const pa = document.createElement('div'); pa.className = 'pa'; pa.textContent = book.author ?? ''
            ph.append(pt, pa)
            cover.append(ph)
        }
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = book.format
        const del = document.createElement('button')
        del.className = 'del'
        del.title = 'Remove from library'
        del.innerHTML = '<svg><use href="#i-trash"/></svg>'
        del.addEventListener('click', async e => {
            e.stopPropagation()
            if (!confirm(`Remove “${book.title}” from your library?`)) return
            await db.deleteBook(book.id)
            renderLibrary()
        })
        cover.append(badge, del)
        const meta = document.createElement('div')
        meta.className = 'meta'
        const title = document.createElement('div'); title.className = 'title'; title.textContent = book.title
        const author = document.createElement('div'); author.className = 'author'; author.textContent = book.author || ' '
        const bar = document.createElement('div'); bar.className = 'bar'
        const fill = document.createElement('i'); fill.style.width = `${Math.round((book.progress ?? 0) * 100)}%`
        bar.append(fill)
        meta.append(title, author)
        if (book.progress) meta.append(bar)
        card.append(cover, meta)
        card.addEventListener('click', () => openReader(book.id))
        card.addEventListener('keydown', e => { if (e.key === 'Enter') openReader(book.id) })
        return card
    })
    els.grid.replaceChildren(...importing.values(), ...cards)
}

const importing = new Map()

const importFiles = async files => {
    let lastId = null
    for (const file of files) {
        const card = document.createElement('div')
        card.className = 'card importing'
        card.innerHTML = '<div class="cover" data-progress="Reading…"></div><div class="meta"><div class="title"></div></div>'
        card.querySelector('.title').textContent = file.name
        const key = Symbol()
        importing.set(key, card)
        els.empty.hidden = true
        els.grid.prepend(card)
        const setProgress = text => card.querySelector('.cover').dataset.progress = text
        try {
            const id = await hashFile(file)
            const existing = await db.getBook(id)
            if (existing) {
                toast(`“${existing.title}” is already in your library`)
                lastId = id
                continue
            }
            const book = await openBook(file, {
                bookId: id,
                pdfMode: settings.pdfMode,
                onProgress: (i, n) => setProgress(`Converting page ${i} of ${n}`),
            })
            setProgress('Saving…')
            let cover = null
            try { cover = await makeThumbnail(await book.getCover?.()) } catch (e) { console.warn(e) }
            const meta = {
                id,
                title: bookTitle(book, file.name),
                author: bookAuthor(book),
                format: book.format,
                fileName: file.name,
                size: file.size,
                cover,
                added: Date.now(),
                progress: 0,
            }
            book.destroy?.()
            await db.addBook(meta, file)
            lastId = id
            toast(`Added “${meta.title}”`)
        } catch (e) {
            console.error(e)
            toast(e instanceof UnsupportedError ? e.message : `Could not open “${file.name}”: ${e.message ?? e}`, { error: true, timeout: 6000 })
        } finally {
            importing.delete(key)
            card.remove()
        }
    }
    await renderLibrary()
    return lastId
}

els.fileInput.addEventListener('change', async () => {
    const files = [...els.fileInput.files]
    els.fileInput.value = ''
    const id = await importFiles(files)
    if (files.length === 1 && id) openReader(id)
})
els.search.addEventListener('input', debounce(renderLibrary, 120))
els.sort.addEventListener('change', () => {
    try { localStorage.setItem('shelf-sort', els.sort.value) } catch {}
    renderLibrary()
})
try { els.sort.value = localStorage.getItem('shelf-sort') ?? 'opened' } catch {}

$('#lib-theme').addEventListener('click', () => {
    setSetting('theme', THEME_CYCLE[(THEME_CYCLE.indexOf(settings.theme) + 1) % THEME_CYCLE.length])
})
const THEME_CYCLE = ['light', 'sepia', 'dark', 'black']

// Drag & drop anywhere on the page.
let dragDepth = 0
const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files')
window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth++
    els.dropOverlay.hidden = false
})
window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return
    if (--dragDepth <= 0) { dragDepth = 0; els.dropOverlay.hidden = true }
})
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault() })
window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth = 0
    els.dropOverlay.hidden = true
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    const id = await importFiles(files)
    if (files.length === 1 && id) openReader(id)
})

// ---------------------------------------------------------------------------------------------
// Reader

let reader = null // { id, meta, book, paginator, tocItems }

const showLoading = (text = '') => {
    els.loadingText.textContent = text
    els.loading.hidden = false
}
const hideLoading = () => { els.loading.hidden = true }

const openReader = async (id, { push = true } = {}) => {
    const meta = await db.getBook(id)
    if (!meta) { closeReader(); return }
    if (reader) closeReader({ push: false })
    if (push) history.pushState({ book: id }, '', `#book=${id}`)
    els.libraryView.hidden = true
    els.readerView.hidden = false
    els.bookTitle.textContent = meta.title
    els.chapterTitle.textContent = ''
    els.pageLabel.textContent = ''
    document.title = `${meta.title} — Shelf`
    showLoading('Opening book…')
    const blob = await db.getFile(id)
    const file = new File([blob], meta.fileName ?? 'book', { type: blob.type })
    let book
    try {
        book = await openBook(file, {
            bookId: id,
            pdfMode: settings.pdfMode,
            onProgress: (i, n) => showLoading(`Converting page ${i} of ${n}…`),
        })
    } catch (e) {
        console.error(e)
        hideLoading()
        toast(`Could not open this book: ${e.message ?? e}`, { error: true, timeout: 6000 })
        closeReader()
        return
    }
    const token = Symbol()
    reader = { id, meta, book, token, tocItems: [] }
    $$('[data-only="pdf"]').forEach(el => el.hidden = !book.pdf)
    const paginator = new Paginator(els.stage, book, settings)
    reader.paginator = paginator
    bindPaginator(paginator)
    renderTOC(book)

    const loc = meta.location
    let start
    if (loc && book.pdf && loc.pdfPage && (loc.pdfMode ?? 'smart') !== book.pdfMode) {
        const r = book.resolveHref(`page:${loc.pdfPage}`)
        start = r ? { index: r.index, anchor: r.anchor } : { index: 0 }
    } else if (loc && loc.index < book.sections.length) {
        start = { index: loc.index, path: loc.path, offset: loc.offset, fraction: loc.sectionFraction }
    } else {
        start = { index: Math.max(0, book.sections.findIndex(s => s.linear !== 'no')) }
    }
    await paginator.goTo(start)
    hideLoading()
    db.updateBook(id, { lastOpened: Date.now() })
    resolveTOC(book)
}

const closeReader = ({ push = true } = {}) => {
    if (reader) {
        saveNow()
        reader.paginator?.destroy()
        reader.book?.destroy?.()
        reader = null
    }
    closePanels()
    hideNote()
    els.readerView.hidden = true
    els.libraryView.hidden = false
    els.readerView.classList.remove('immersive')
    document.title = 'Shelf'
    if (push && location.hash) history.pushState({}, '', location.pathname)
    renderLibrary()
}

window.addEventListener('popstate', () => {
    const m = location.hash.match(/^#book=(\w+)/)
    if (m) { if (reader?.id !== m[1]) openReader(m[1], { push: false }) }
    else if (reader) closeReader({ push: false })
})

// --- progress -----------------------------------------------------------------------------

const saveNow = () => {
    if (!reader?.paginator) return
    const loc = reader.paginator.getLocation()
    if (!loc) return
    if (reader.book.pdf) loc.pdfMode = reader.book.pdfMode
    const p = reader.paginator.progress()
    db.updateBook(reader.id, { location: loc, progress: p?.atEnd ? 1 : loc.fraction, lastOpened: Date.now() })
}
const saveProgress = debounce(saveNow, 800)
window.addEventListener('pagehide', saveNow)
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow() })

const updateProgressUI = p => {
    if (!p) return
    const range = p.pageEnd > p.page ? `${p.page}–${p.pageEnd}` : `${p.page}`
    els.pageLabel.textContent = `${range} of ${p.exact ? '' : '~'}${p.total}`
    els.pageLabel.title = p.sectionPagesLeft ? `${p.sectionPagesLeft} more screen${p.sectionPagesLeft > 1 ? 's' : ''} in this chapter` : ''
    if (!sliderActive) els.progress.value = Math.round(p.fraction * 1000)
}

let sliderActive = false
els.progress.addEventListener('input', () => {
    sliderActive = true
    if (!reader) return
    const p = reader.paginator.progress()
    if (p) els.pageLabel.textContent = `Go to ~${Math.max(1, Math.round(els.progress.value / 1000 * p.total))} of ${p.total}`
})
els.progress.addEventListener('change', async () => {
    sliderActive = false
    if (reader) await reader.paginator.goToFraction(els.progress.value / 1000)
})

// --- paginator events -----------------------------------------------------------------------

let loadingTimer
const bindPaginator = paginator => {
    paginator.addEventListener('relocate', e => {
        updateProgressUI(e.detail)
        updateCurrentChapter()
        saveProgress()
        hideNote()
    })
    paginator.addEventListener('loading', e => {
        clearTimeout(loadingTimer)
        if (e.detail) loadingTimer = setTimeout(() => showLoading(''), 250)
        else hideLoading()
    })
    paginator.addEventListener('error', e => toast(`Part of this book could not be displayed (${e.detail?.message ?? e.detail})`, { error: true }))
    paginator.addEventListener('tap', e => onTap(e.detail))
    paginator.addEventListener('link', e => onLink(e.detail))
    paginator.addEventListener('doc-keydown', e => onKeydown(e.detail))
    paginator.addEventListener('doc-wheel', e => onWheel(e.detail))
    paginator.addEventListener('doc-touchstart', e => onTouchStart(e.detail))
    paginator.addEventListener('doc-touchend', e => onTouchEnd(e.detail))
}

const onTap = ({ x, width }) => {
    if (!els.notePopup.hidden) { hideNote(); return }
    if (!els.tocPanel.hidden || !els.settingsPanel.hidden) { closePanels(); return }
    if (x < width * 0.28) reader?.paginator.prev()
    else if (x > width * 0.72) reader?.paginator.next()
    else els.readerView.classList.toggle('immersive')
}

els.stage.addEventListener('click', e => {
    if (e.target.closest('.textLayer') && getSelection().toString()) return
    const r = els.stage.getBoundingClientRect()
    onTap({ x: e.clientX - r.left, y: e.clientY - r.top, width: r.width, height: r.height })
})

// --- links & footnotes ------------------------------------------------------------------------

const NOTE_TYPES = /\b(footnote|endnote|rearnote|note)\b/
const isNoteElement = el => {
    for (let n = el; n && n.nodeType === 1 && n.localName !== 'body'; n = n.parentElement) {
        if (NOTE_TYPES.test(epubType(n))) return true
        if (/doc-(foot|end)note/.test(n.getAttribute('role') ?? '')) return true
        if (n.localName === 'aside') return true
        if (/(^|[\s_-])(foot|end)?notes?($|[\s_-])/i.test(n.className?.baseVal ?? n.className ?? '')) return true
    }
    return false
}
const looksLikeNoteRef = a =>
    /noteref/.test(epubType(a)) || a.getAttribute('role') === 'doc-noteref' || !!a.closest('sup')
    || /^\s*[[(]?\s*(\d{1,4}|[*†‡§¶]+|[a-z])\s*[\])]?\s*$/i.test(a.textContent)

const sanitize = (node) => {
    const clone = document.importNode(node, true)
    const all = [clone, ...clone.querySelectorAll('*')]
    for (const el of all) {
        if (/^(script|iframe|object|embed|style|link|form)$/i.test(el.localName)) { el.remove(); continue }
        for (const attr of [...el.attributes]) {
            if (/^on/i.test(attr.name) || (/href|src/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) el.removeAttribute(attr.name)
        }
    }
    return clone
}

const hideNote = () => { els.notePopup.hidden = true }

const showNote = (target, a, doc) => {
    let content = target
    if (content.textContent.trim().length < 4 || content.localName === 'a')
        content = target.closest('p, li, dd, div, aside, section') ?? target.parentElement ?? target
    const body = els.notePopup.querySelector('.note-body')
    body.replaceChildren(sanitize(content))
    // Back-links inside the note are useless in a popup.
    body.querySelectorAll('a[href]').forEach(x => x.removeAttribute('href'))
    els.notePopup.hidden = false
    // Position near the reference.
    const d = reader.paginator.display
    const sr = els.stage.getBoundingClientRect()
    const r = a.getBoundingClientRect()
    let x, y
    if (d?.type === 'flow' && d.doc === doc) {
        x = sr.left + (r.left - reader.paginator.view * d.dims.W) * d.dims.z
        y = sr.top + r.bottom * d.dims.z
    } else {
        const fr = doc.defaultView.frameElement.getBoundingClientRect()
        const scale = fr.width / doc.defaultView.frameElement.offsetWidth
        x = fr.left + r.left * scale
        y = fr.top + r.bottom * scale
    }
    const pw = els.notePopup.offsetWidth, ph = els.notePopup.offsetHeight
    const left = Math.max(12, Math.min(innerWidth - pw - 12, x - pw / 2))
    const top = y + ph + 16 > innerHeight ? Math.max(12, y - ph - 30) : y + 8
    els.notePopup.style.left = `${left}px`
    els.notePopup.style.top = `${top}px`
}

const onLink = async ({ a, doc, index }) => {
    if (!reader) return
    const { book, paginator } = reader
    const href_ = a.getAttribute('href')
    const section = book.sections[index]
    const href = section?.resolveHref?.(href_) ?? href_
    if (book.isExternal?.(href)) {
        if (/^(https?|mailto):/i.test(href_)) window.open(href_, '_blank', 'noopener')
        return
    }
    let resolved
    try { resolved = await book.resolveHref?.(href) } catch (e) { console.warn(e) }
    if (!resolved || resolved.index == null || resolved.index < 0) return
    // Footnotes: show them in a popup instead of jumping away.
    try {
        const targetSection = book.sections[resolved.index]
        const nonLinear = targetSection?.linear === 'no'
        if (resolved.anchor && (looksLikeNoteRef(a) || nonLinear)) {
            const targetDoc = resolved.index === index ? doc : await targetSection.createDocument?.()
            const target = targetDoc ? await resolved.anchor(targetDoc) : null
            if (target?.nodeType === 1 && (nonLinear || isNoteElement(target) || looksLikeNoteRef(a))
                && target.textContent.trim().length < 3000) {
                showNote(target, a, doc)
                return
            }
        }
    } catch (e) { console.warn(e) }
    paginator.goTo({ index: resolved.index, anchor: resolved.anchor })
}

els.notePopup.addEventListener('click', e => e.stopPropagation())

// --- TOC ------------------------------------------------------------------------------------

const renderTOC = book => {
    const build = items => {
        const ul = document.createElement('ul')
        for (const item of items ?? []) {
            const li = document.createElement('li')
            const a = document.createElement('a')
            a.href = '#'
            a.textContent = (item.label ?? '').trim() || '—'
            a.addEventListener('click', async e => {
                e.preventDefault()
                if (!item.href) return
                closePanels()
                await reader?.paginator.goToHref(item.href)
            })
            item.el = a
            li.append(a)
            if (item.subitems?.length) li.append(build(item.subitems))
            ul.append(li)
        }
        return ul
    }
    const toc = book.toc?.length ? book.toc : []
    els.toc.replaceChildren(toc.length ? build(toc) : Object.assign(document.createElement('p'), {
        textContent: 'This book has no table of contents.', style: 'padding: 0 18px; color: var(--muted)',
    }))
}

const resolveTOC = async book => {
    const flat = []
    const walk = items => { for (const i of items ?? []) { flat.push(i); walk(i.subitems) } }
    walk(book.toc)
    const myReader = reader
    for (const item of flat) {
        if (reader !== myReader) return
        try {
            const r = item.href ? await book.resolveHref(item.href) : null
            if (r && r.index >= 0) { item.index = r.index; item.anchor = r.anchor }
        } catch {}
    }
    if (reader === myReader) { reader.tocItems = flat.filter(i => i.index != null); updateCurrentChapter() }
}

const updateCurrentChapter = debounce(async () => {
    if (!reader) return
    const { paginator, tocItems } = reader
    const p = paginator.progress()
    if (!p) return
    let current = null
    for (const item of tocItems) {
        if (item.index < p.index) current = item
        else if (item.index === p.index) {
            if (!item.anchor) { current = item; continue }
            const v = await paginator.viewOf(item.anchor)
            if (v <= p.view) current = item
        }
    }
    for (const item of tocItems) item.el?.classList.toggle('current', item === current)
    els.chapterTitle.textContent = current?.label?.trim() ?? ''
}, 100)

// --- panels & buttons ------------------------------------------------------------------------

const closePanels = () => {
    els.tocPanel.hidden = true
    els.settingsPanel.hidden = true
}
const togglePanel = panel => {
    const open = panel.hidden
    closePanels()
    panel.hidden = !open
    if (open && panel === els.tocPanel) els.toc.querySelector('a.current')?.scrollIntoView({ block: 'center' })
}
$$('[data-close]').forEach(b => b.addEventListener('click', closePanels))
$('#btn-library').addEventListener('click', () => closeReader())
$('#btn-toc').addEventListener('click', () => togglePanel(els.tocPanel))
$('#btn-settings').addEventListener('click', () => togglePanel(els.settingsPanel))
$('#btn-prev').addEventListener('click', () => reader?.paginator.prev())
$('#btn-next').addEventListener('click', () => reader?.paginator.next())
const toggleFullscreen = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()
$('#btn-full').addEventListener('click', toggleFullscreen)

// --- input --------------------------------------------------------------------------------

const onKeydown = e => {
    if (!reader || els.readerView.hidden) return
    if (e.target?.closest?.('input, select, textarea')) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const p = reader.paginator
    switch (e.key) {
        case 'ArrowRight': case 'PageDown': case 'ArrowDown': p.next(); break
        case 'ArrowLeft': case 'PageUp': case 'ArrowUp': p.prev(); break
        case ' ': e.shiftKey ? p.prev() : p.next(); break
        case 'Home': p.goTo({ index: 0 }); break
        case 'End': p.goTo({ index: reader.book.sections.length - 1, end: true }); break
        case 'Escape':
            if (!els.notePopup.hidden) hideNote()
            else if (!els.tocPanel.hidden || !els.settingsPanel.hidden) closePanels()
            else if (document.fullscreenElement) document.exitFullscreen()
            else closeReader()
            break
        case 't': case 'T': togglePanel(els.tocPanel); break
        case 'a': case 'A': togglePanel(els.settingsPanel); break
        case 'f': case 'F': toggleFullscreen(); break
        case '+': case '=': setSetting('zoom', Math.min(250, settings.zoom + 10)); syncControls(); break
        case '-': setSetting('zoom', Math.max(50, settings.zoom - 10)); syncControls(); break
        case '0': setSetting('zoom', 100); syncControls(); break
        default: return
    }
    e.preventDefault()
}
document.addEventListener('keydown', onKeydown)

let wheelAcc = 0, wheelLock = 0
const onWheel = e => {
    if (!reader || e.ctrlKey) return
    if (e.target?.closest?.('.drawer, .note-popup')) return
    e.preventDefault?.()
    const now = performance.now()
    if (now < wheelLock) return
    wheelAcc += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    if (Math.abs(wheelAcc) > 40) {
        wheelAcc > 0 ? reader.paginator.next() : reader.paginator.prev()
        wheelAcc = 0
        wheelLock = now + 220
    }
}
els.stage.addEventListener('wheel', onWheel, { passive: false })

let touch = null
const onTouchStart = e => {
    const t = e.changedTouches[0]
    touch = { x: t.screenX, y: t.screenY, time: Date.now() }
}
const onTouchEnd = e => {
    if (!touch || !reader) return
    const t = e.changedTouches[0]
    const dx = t.screenX - touch.x, dy = t.screenY - touch.y
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - touch.time < 800)
        dx < 0 ? reader.paginator.next() : reader.paginator.prev()
    touch = null
}
els.stage.addEventListener('touchstart', onTouchStart, { passive: true })
els.stage.addEventListener('touchend', onTouchEnd, { passive: true })

// --- settings panel ---------------------------------------------------------------------------

const formatSetting = (key, value) => {
    if (key === 'zoom') return `${value}%`
    if (key === 'lineHeight') return Number(value) ? Number(value).toFixed(1) : 'Original'
    if (key === 'marginSide') return `${value}%`
    if (key === 'marginV') return `${value}px`
    return String(value)
}

const syncControls = () => {
    for (const el of $$('[data-setting]')) {
        const key = el.dataset.setting
        const value = settings[key]
        if (el.classList.contains('seg')) {
            el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.value === value))
        } else if (el.type === 'checkbox') el.checked = !!value
        else el.value = value
    }
    for (const out of $$('output[data-for]')) out.textContent = formatSetting(out.dataset.for, settings[out.dataset.for])
    $('#custom-font-row').hidden = settings.fontFamily !== 'custom'
}

for (const el of $$('[data-setting]')) {
    const key = el.dataset.setting
    if (el.classList.contains('seg')) {
        el.addEventListener('click', e => {
            const b = e.target.closest('button[data-value]')
            if (b) { setSetting(key, b.dataset.value); syncControls() }
        })
    } else {
        el.addEventListener('input', () => {
            const value = el.type === 'checkbox' ? el.checked
                : el.type === 'range' ? Number(el.value) : el.value
            setSetting(key, value)
            syncControls()
        })
    }
}
// −/+ step through the size list; from "Original" they start at the size the book uses.
const stepTextSize = dir => {
    const sizes = [...$('#s-size').options].map(o => o.value).filter(v => v !== 'original').map(Number)
    let current = Number(settings.textSize)
    if (!current) current = reader?.paginator.baseTextSize() ?? 12
    const next = dir > 0 ? sizes.find(s => s > current) : sizes.findLast(s => s < current)
    if (next) { setSetting('textSize', String(next)); syncControls() }
}
$('#btn-size-down').addEventListener('click', () => stepTextSize(-1))
$('#btn-size-up').addEventListener('click', () => stepTextSize(1))

$('#btn-reset').addEventListener('click', () => { resetSettings(); syncControls() })

$('#btn-local-fonts').addEventListener('click', async () => {
    if (!window.queryLocalFonts) {
        toast('This browser cannot list installed fonts. Type the font name instead.')
        return
    }
    try {
        const fonts = await window.queryLocalFonts()
        const families = [...new Set(fonts.map(f => f.family))].sort((a, b) => a.localeCompare(b))
        const list = $('#font-list')
        list.replaceChildren(...families.map(f => Object.assign(document.createElement('option'), { value: f })))
        toast(`${families.length} installed fonts available in the font box`)
        $('#s-custom-font').focus()
    } catch (e) {
        toast('Permission to list fonts was denied.', { error: true })
    }
})

const relayoutSoon = debounce(() => reader?.paginator.relayout(), 60)

const reopenForPdfMode = async () => {
    if (!reader?.book?.pdf) return
    const { paginator, book } = reader
    const loc = paginator.getLocation()
    book.setMode(settings.pdfMode)
    paginator.destroy()
    const next = new Paginator(els.stage, book, settings)
    reader.paginator = next
    bindPaginator(next)
    const r = loc?.pdfPage ? book.resolveHref(`page:${loc.pdfPage}`) : null
    await next.goTo(r ? { index: r.index, anchor: r.anchor } : { index: 0 })
    resolveTOC(book)
}

onSettingChange(key => {
    if (key === 'theme') applyTheme()
    if (!reader) return
    if (key === 'pdfMode') reopenForPdfMode()
    else if (key === 'customFont' || key === 'fontFamily') {
        if (settings.fontFamily !== 'custom' || settings.customFont.trim()) relayoutSoon()
    } else relayoutSoon()
})

// ---------------------------------------------------------------------------------------------
// Start

applyTheme()
syncControls()
navigator.storage?.persist?.().catch(() => {})

// Web-app version: offline support/installation, and books opened with "Open with → Shelf".
if (location.protocol !== 'chrome-extension:') {
    // Not on localhost, so local edits show up on reload during development.
    if ('serviceWorker' in navigator && window.isSecureContext && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname))
        navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker not registered', e))
    window.launchQueue?.setConsumer(async ({ files }) => {
        if (!files?.length) return
        const id = await importFiles(await Promise.all(files.map(h => h.getFile())))
        if (files.length === 1 && id) openReader(id)
    })
}
renderLibrary().then(() => {
    const m = location.hash.match(/^#book=(\w+)/)
    if (m) openReader(m[1], { push: false })
})
