// Continuous-scroll book view.
//
// The book is one vertical strip with no visible page breaks: every section (a chapter file, a
// run of reflowed PDF pages, an original PDF page…) is a block in a single scrolling container.
// Reflowable sections are rendered in iframes as tall as their content, so the text just flows
// on. Only blocks near the screen are loaded; the rest are placeholders that are measured in the
// background, so their height is usually exact long before you reach them. When a height above
// the screen does change, the browser's scroll anchoring keeps the text you are reading still.
//
// Pages exist only in the page map behind the scroller at the bottom: the book's own pages when
// it has them (an EPUB page list, a PDF's pages), otherwise one screen-height page at a time,
// with every section starting a new page.
//
// The scroll position is the single source of truth. The current page, how far into that page
// the screen is, and the saved location are all derived from it, never stored separately.

import { THEMES, MARGIN_SIZES, fontStack } from './settings.js'

const ATOMIC_SELECTOR = [
    'figure', 'table', 'svg', 'pre', 'math', 'video', 'canvas', 'object', 'dl.equation',
    '[class*="figure" i]', '[class*="chart" i]', '[class*="graph" i]', '[class*="diagram" i]',
    '[class*="equation" i]', '[class*="formula" i]', '[class*="table" i]:not(body):not(html)',
    '[*|type~="figure"]', '[*|type~="table"]', '[role="figure"]', '[role="table"]',
].join(',')
const TABLE_LIKE = 'table, pre, [class*="table" i]'

const wait = ms => new Promise(r => setTimeout(r, ms))
const idle = () => new Promise(r => (window.requestIdleCallback ?? setTimeout)(() => r(), { timeout: 200 }))
// Next frame, or a short timeout when the page is hidden and frames don't run.
const nextFrame = fn => {
    let done = false
    const run = () => { if (!done) { done = true; fn() } }
    requestAnimationFrame(run)
    setTimeout(run, 100)
}

const loadIframe = (iframe, url) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), 15000)
    iframe.addEventListener('load', () => { clearTimeout(timer); resolve() }, { once: true })
    iframe.addEventListener('error', e => { clearTimeout(timer); reject(e) }, { once: true })
    iframe.src = url
})

// On the web version, dictionary extensions such as Yomitan need scripting enabled in the book
// frames to inject their content scripts, so the frames are not sandboxed there (a sandbox that
// allows scripts on a same-origin frame protects nothing anyway). Book scripts still never run:
// the frames inherit reader.html's Content-Security-Policy (script-src 'self'), which blocks
// inline scripts, event handler attributes, javascript: links and blob: scripts.
const IS_EXTENSION = location.protocol === 'chrome-extension:'

const makeIframe = () => {
    const iframe = document.createElement('iframe')
    if (IS_EXTENSION) iframe.setAttribute('sandbox', 'allow-same-origin')
    iframe.setAttribute('scrolling', 'no')
    iframe.setAttribute('tabindex', '-1')
    return iframe
}

// ---------------------------------------------------------------------------------------------
// Layout of a reflowable document

const themeCSS = s => {
    const t = THEMES[s.theme] ?? THEMES.light
    if (s.theme === 'light') return `html { background: ${t.bg} !important; }`
    return `
html, body { background: ${t.bg} !important; color: ${t.fg} !important; }
body *:not(img):not(svg):not(svg *):not(video):not(canvas) {
    color: inherit !important; background-color: transparent !important;
    border-color: color-mix(in srgb, ${t.fg} 35%, transparent) !important; }
a:link, a:visited, a:link *, a:visited * { color: ${t.link} !important; }
svg text { fill: currentColor; }
${t.dark ? `img, svg, video { filter: brightness(.88) contrast(1.05); }
img[data-br-imgbg] { background-color: #fff !important; }` : ''}`
}

const layoutCSS = (d, s, textDir) => {
    const font = fontStack(s)
    const lh = Number(s.lineHeight)
    const maxH = d.sh - 2 * d.gap
    const alignSel = 'p:not([class*="center" i]):not([class*="right" i]):not([style*="text-align" i]):not([align]), li, dd, blockquote'
    return `
html {
    width: ${d.W}px !important; height: auto !important;
    min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important;
    margin: 0 !important; padding: ${d.gap}px ${d.mH}px !important; box-sizing: border-box !important;
    columns: auto !important; column-count: auto !important;
    overflow: hidden !important; direction: ltr !important; writing-mode: horizontal-tb !important;
    -webkit-text-size-adjust: none; text-size-adjust: none;
}
body {
    height: auto !important; min-height: 0 !important; max-height: none !important;
    width: auto !important; max-width: none !important; overflow: visible !important;
    position: static !important; float: none !important; column-count: auto !important; columns: auto !important;
    /* Browsers carry the <body>'s direction and writing mode up to the document itself; the
       strip always runs top to bottom, so right-to-left text keeps its direction one level down
       and vertical (Japanese) text is laid out horizontally. */
    direction: ltr !important; writing-mode: horizontal-tb !important;
}
${textDir === 'rtl' ? 'body > * { direction: rtl; }' : ''}
img, video, canvas, object { max-width: 100% !important; max-height: ${maxH}px !important; object-fit: contain; box-sizing: border-box; }
svg { max-width: 100% !important; max-height: ${maxH}px !important; }
aside[*|type~="footnote"], aside[*|type~="note"], aside[role="doc-footnote"] { display: none !important; }
#br-end { display: block !important; height: 0 !important; margin: 0 !important; padding: 0 !important; border: 0 !important; float: none !important; clear: both; }
html.br-image-page { padding: 0 ${d.mH}px !important; }
html.br-image-page body { height: ${d.sh}px !important; margin: 0 !important; padding: 0 !important;
    display: flex !important; flex-direction: column; align-items: center; justify-content: center; }
html.br-image-page body > * { margin: 0 !important; max-height: ${maxH}px; max-width: 100%; }
html.br-image-page svg { height: ${maxH}px !important; width: 100% !important; }
${font ? `body, body *:not(pre):not(code):not(kbd):not(samp):not(tt):not(math):not(math *):not(svg *) { font-family: ${font} !important; }` : ''}
${lh ? `body, body p, body div, body li, body span, body blockquote, body dd, body a { line-height: ${lh} !important; }` : ''}
${s.align === 'justify' ? `${alignSel} { text-align: justify !important; }` : s.align === 'left' ? `${alignSel} { text-align: start !important; }` : ''}
body { hyphens: ${s.hyphenate ? 'auto' : 'manual'}; -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'}; }
${themeCSS(s)}
`
}

const visualUnits = (doc) => {
    const body = doc.body
    const set = new Set(doc.querySelectorAll(ATOMIC_SELECTOR))
    // An image together with its short caption forms one unit.
    for (const img of doc.querySelectorAll('img')) {
        if (img.closest(ATOMIC_SELECTOR)) continue
        let unit = img, p = img.parentElement
        for (let depth = 0; p && p !== body && depth < 3; depth++, p = p.parentElement) {
            const text = p.textContent.trim().length
            if (text > 260 || p.querySelectorAll('img').length > 4) break
            const display = doc.defaultView.getComputedStyle(p).display
            if (display.startsWith('inline')) continue
            unit = p
        }
        if (unit === img) {
            // Inline images (drop caps, glyphs) are not visual units.
            if ((img.getAttribute('height') ?? '').match(/em$/) || img.getBoundingClientRect().height < 40) continue
        }
        set.add(unit)
    }
    // Keep only outermost units.
    return [...set].filter(el => {
        if (!el.isConnected || el === body || el === doc.documentElement) return false
        for (let p = el.parentElement; p && p !== body; p = p.parentElement) if (set.has(p)) return false
        return true
    })
}

// Text size in points (as in Google Docs). The book's main body text gets exactly that size and
// everything else (headings, notes, small print) keeps its proportion to it. Every element gets
// an explicit size so books that use px sizes scale as well as books that use em.
const PX_PER_PT = 4 / 3
const applyTextSize = (doc, s) => {
    for (const el of doc.querySelectorAll('[data-br-fs]')) {
        el.style.removeProperty('font-size')
        el.style.removeProperty('line-height')
        el.removeAttribute('data-br-fs')
    }
    const win = doc.defaultView
    const els = [doc.body, ...doc.body.querySelectorAll('*')].filter(el => !el.closest('svg, math'))
    const styles = els.map(el => win.getComputedStyle(el))
    const sizes = styles.map(cs => parseFloat(cs.fontSize))
    const weight = new Map()
    els.forEach((el, i) => {
        let n = 0
        for (const c of el.childNodes) if (c.nodeType === 3) n += c.nodeValue.trim().length
        if (n) {
            const k = Math.round(sizes[i] * 2) / 2
            weight.set(k, (weight.get(k) ?? 0) + n)
        }
    })
    const base = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (base) doc.brBaseTextSize = base / PX_PER_PT
    const pt = Number(s.textSize)
    if (!pt || !base) return
    const ratio = pt * PX_PER_PT / base
    if (Math.abs(ratio - 1) < 0.001) return
    // Read everything first, then write, to avoid a relayout per element.
    const lineHeights = Number(s.lineHeight) ? null : styles.map(cs => cs.lineHeight)
    els.forEach((el, i) => {
        el.style.setProperty('font-size', `${(sizes[i] * ratio).toFixed(2)}px`, 'important')
        const lh = lineHeights?.[i]
        if (lh && lh.endsWith('px')) el.style.setProperty('line-height', `${(parseFloat(lh) * ratio).toFixed(2)}px`, 'important')
        el.setAttribute('data-br-fs', '')
    })
}

const waitForImages = async doc => {
    const imgs = [...doc.images].filter(img => !img.complete)
    for (const img of doc.images) if (img.loading === 'lazy') img.loading = 'eager'
    if (imgs.length) await Promise.race([
        Promise.all(imgs.map(img => img.decode().catch(() => {}))),
        wait(2000),
    ])
}

// Fonts named "@…" (e.g. "@MS Mincho") are Windows' rotated variants for vertical text. Text
// is always laid out horizontally, where they space and rotate characters oddly, so use the
// same font without the "@" (the normal, horizontal MS Mincho/Gothic) instead.
const stripVerticalFonts = doc => {
    const fix = family => family.replace(/(^|,)(\s*["']?)@/g, '$1$2')
    const walk = rules => {
        for (const rule of rules) {
            if (rule.style?.fontFamily?.includes('@')) rule.style.fontFamily = fix(rule.style.fontFamily)
            if (rule.cssRules) walk(rule.cssRules)
        }
    }
    for (const sheet of doc.styleSheets) {
        try { walk(sheet.cssRules) } catch {}
    }
    for (const el of doc.querySelectorAll('[style*="@"]')) {
        if (el.style.fontFamily.includes('@')) el.style.fontFamily = fix(el.style.fontFamily)
    }
}

// Some converted books (MOBI/AZW especially) have a stray space after every inline tag, which
// shows up as "Hitler ’s", "<i>The Coming War</i> ." or "A<small>MERICANS</small> ,". Remove
// whitespace that sits between the end of an element and closing punctuation (or a dash glued
// to the next word). Spaces before an opening "(" or "“" are left alone since those are real.
const CLOSING_PUNCT = /^[ \t\r\n]+(?=[,.)\]’”]|[—–-][^\s])/
const BLOCKISH = /^(br|p|div|li|h[1-6]|img|td|tr|table|ul|ol|blockquote)$/i
const isBlankText = n => n.nodeType === Node.TEXT_NODE && !n.data.trim()
const isEmptyAnchor = n => n.nodeType === Node.ELEMENT_NODE && n.localName === 'a'
    && !n.textContent.trim() && !n.querySelector('img')
export const tightenPunctuation = root => {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const leading = [], trailing = []
    for (let node; (node = walker.nextNode());) {
        if (!CLOSING_PUNCT.test(node.data)) continue
        // Look back past blank text and empty anchors (<a id="…"></a>) to what the space follows
        const blanks = []
        let prev = node.previousSibling, anchor = false
        while (prev && (isBlankText(prev) || isEmptyAnchor(prev))) {
            if (prev.nodeType === Node.TEXT_NODE) blanks.push(prev)
            else anchor = true
            prev = prev.previousSibling
        }
        if (prev?.nodeType === Node.ELEMENT_NODE && !BLOCKISH.test(prev.localName)) leading.push(node, ...blanks)
        else if (anchor && prev?.nodeType === Node.TEXT_NODE) leading.push(node, ...blanks), trailing.push(prev)
    }
    for (const node of leading) node.data = node.data.replace(/^[ \t\r\n]+/, '')
    for (const node of trailing) node.data = node.data.replace(/[ \t\r\n]+$/, '')
}

/** Lays out a reflowable document for the given dimensions; returns its height in px. */
export const layoutFlow = async (doc, d, s) => {
    const html = doc.documentElement
    if (!doc.body) return 1
    let style = doc.getElementById('br-style')
    if (!style) {
        // The text direction the book itself asks for (Arabic, Hebrew…), read before our
        // styles override it. A right-to-left *page order* (common in Japanese books) is not
        // a reason to make the text right-to-left.
        doc.brTextDir = doc.defaultView.getComputedStyle(doc.body).direction
        stripVerticalFonts(doc)
        tightenPunctuation(doc.body)
        style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style')
        style.id = 'br-style'
            ; (doc.head ?? html).append(style)
    }
    // Our style must come last to win over the book's own stylesheets.
    if (style.nextElementSibling) style.parentNode.append(style)
    style.textContent = layoutCSS(d, s, doc.brTextDir)
    let end = doc.getElementById('br-end')
    if (!end) {
        end = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div')
        end.id = 'br-end'
    }
    doc.body.append(end)

    await waitForImages(doc)
    try { await doc.fonts?.ready } catch {}

    for (const el of doc.querySelectorAll('[data-br-zoom]')) { el.style.removeProperty('zoom'); el.removeAttribute('data-br-zoom') }
    html.classList.remove('br-image-page')
    applyTextSize(doc, s)

    const t = THEMES[s.theme] ?? THEMES.light
    for (const img of doc.images) {
        if (t.dark && img.naturalWidth > 64 && img.naturalHeight > 64) img.setAttribute('data-br-imgbg', '')
        else img.removeAttribute('data-br-imgbg')
    }

    const body = doc.body
    const textLength = body.textContent.replace(/\s+/g, '').length
    if (textLength < 30 && body.querySelectorAll('img, svg, video, canvas').length === 1) {
        // A section that is just a picture (cover, plate) gets one screen, centred.
        html.classList.add('br-image-page')
    } else {
        // Figures and tables wider than the text column are scaled down to fit it.
        for (const el of visualUnits(doc)) {
            const w = Math.max(el.getBoundingClientRect().width, el.scrollWidth)
            if (w <= d.cw + 1) continue
            const minScale = el.matches(TABLE_LIKE) || el.querySelector('table') ? 0.55 : 0.3
            el.style.setProperty('zoom', Math.max(d.cw / w, minScale).toFixed(4), 'important')
            el.setAttribute('data-br-zoom', '')
        }
    }
    return measureFlow(doc)
}

const measureFlow = doc => {
    const html = doc.documentElement
    const win = doc.defaultView
    if (html.classList.contains('br-image-page')) return Math.ceil(html.getBoundingClientRect().height)
    const end = doc.getElementById('br-end')
    if (!end || !doc.body) return Math.max(1, Math.ceil(html.getBoundingClientRect().height))
    const bottom = end.getBoundingClientRect().bottom + win.scrollY
        + (parseFloat(win.getComputedStyle(doc.body).marginBottom) || 0)
        + (parseFloat(win.getComputedStyle(html).paddingBottom) || 0)
    return Math.max(1, Math.ceil(bottom))
}

// ---------------------------------------------------------------------------------------------
// Locations inside a document: [child indexes from <body>] + character offset.

const nodePath = (root, node) => {
    const path = []
    for (let n = node; n && n !== root; n = n.parentNode) {
        const parent = n.parentNode
        if (!parent) return null
        path.unshift(Array.prototype.indexOf.call(parent.childNodes, n))
    }
    return path
}
const resolvePath = (root, path) => {
    let n = root
    for (const i of path ?? []) {
        if (!n.childNodes[i]) return n
        n = n.childNodes[i]
    }
    return n
}

// Top of an anchor target inside a document (element, range or nothing).
const topOf = (doc, target) => {
    const win = doc.defaultView
    if (!target || typeof target === 'number') return 0
    if (target instanceof win.Range) {
        const r = target.getClientRects()[0] ?? target.getBoundingClientRect()
        return r.top + win.scrollY
    }
    // Elements without a box of their own (display: none, empty) use the next thing that has one.
    for (let el = target; el; el = el.nextElementSibling ?? el.parentElement) {
        const r = el.getClientRects()[0]
        if (r) return r.top + win.scrollY
        if (el === doc.body) break
    }
    return 0
}

// ---------------------------------------------------------------------------------------------

export class Paginator extends EventTarget {
    #stage
    #scroller
    #settings
    #dims
    #blocks = []
    #blockOf = new Map()
    #tops = null
    #pages = null
    #original = false
    #targets = new Map()
    #gen = 0
    #measureGen = 0
    #navToken = 0
    #measureTimer
    #resizeTimer
    #updateQueued = false
    #keyTarget = null
    #ready
    book

    constructor(stage, book, settings) {
        super()
        this.#stage = stage
        this.book = book
        this.#settings = settings
        this.#scroller = document.createElement('div')
        this.#scroller.className = 'scroller'
        stage.append(this.#scroller)
        this.#dims = this.#computeDims()

        // Non-linear sections (pop-up notes, alternative covers) are not part of the strip.
        let order = book.sections.map((_, i) => i).filter(i => book.sections[i].linear !== 'no')
        if (!order.length) order = book.sections.map((_, i) => i)
        for (const i of order) {
            const el = document.createElement('div')
            el.className = 'block'
            this.#scroller.append(el)
            const b = { i, el, h: 0, measured: false, markers: null, live: null, loading: null }
            this.#blocks.push(b)
            this.#blockOf.set(i, b)
        }
        this.#estimateAll()
        this.#ready = this.#findOriginalPages().then(() => this.#estimateAll())

        this.#scroller.addEventListener('scroll', () => this.#queueUpdate(), { passive: true })
        this.resizeObserver = new ResizeObserver(() => {
            clearTimeout(this.#resizeTimer)
            this.#resizeTimer = setTimeout(() => this.relayout(), 150)
        })
        this.resizeObserver.observe(stage)
    }

    #computeDims() {
        const s = this.#settings
        const rect = this.#stage.getBoundingClientRect()
        const sw = Math.max(200, rect.width), sh = Math.max(200, rect.height)
        // Side margins are a percentage of the width, so they scale with the screen; the text
        // column stays at least 260 CSS px wide.
        const pct = (MARGIN_SIZES[s.marginSize] ?? MARGIN_SIZES[1]).share
        const mH = Math.max(0, Math.min(pct * sw, (sw - 260) / 2))
        const gap = Math.round(Math.min(40, sh * 0.05))
        return { sw, sh, W: sw, mH, cw: sw - 2 * mH, gap }
    }

    // --- the book's own pages ---------------------------------------------------------------------

    // PDFs always have their pages; EPUBs may have a page list (the printed edition's pages).
    async #findOriginalPages() {
        const book = this.book
        if (book.pdf) {
            for (const b of this.#blocks) {
                const s = book.sections[b.i]
                const ns = s.render ? [s.pdfPage] : s.pages ?? []
                this.#targets.set(b.i, ns.map(n => ({
                    label: String(n),
                    anchor: s.render ? null : doc => doc.getElementById(`pdf-p${n}`),
                })))
            }
            this.#original = true
            return
        }
        if (!book.pageList?.length) return
        for (const item of book.pageList) {
            try {
                const r = item.href ? await book.resolveHref(item.href) : null
                if (!r || !this.#blockOf.has(r.index)) continue
                const list = this.#targets.get(r.index) ?? []
                list.push({ label: (item.label ?? '').trim(), anchor: r.anchor ?? null })
                this.#targets.set(r.index, list)
            } catch {}
        }
        this.#original = this.#targets.size > 0
        this.#pages = null
    }

    #findMarkers(b, doc) {
        if (!this.#original) return null
        const markers = []
        for (const t of this.#targets.get(b.i) ?? []) {
            let y = 0
            if (doc && t.anchor) {
                try { y = topOf(doc, t.anchor(doc)) } catch {}
            }
            markers.push({ y: Math.max(0, Math.round(y)), label: t.label })
        }
        return markers.sort((a, b) => a.y - b.y)
    }

    // Until a block is measured its pages are spread evenly over its estimated height.
    #estimatedMarkers(b) {
        const list = this.#targets.get(b.i) ?? []
        const fixed = this.#isFixed(b)
        return list.map((t, k) => ({ y: fixed ? 0 : Math.round(b.h * k / list.length), label: t.label }))
    }

    // --- sizes --------------------------------------------------------------------------------

    #isFixed(b) {
        const s = this.book.sections[b.i]
        return !!(s.render || s.fixed)
    }

    // Original pages are fitted to the text column's width, but never so large that one page is
    // much taller than the screen.
    #fixedSize(b) {
        const s = this.book.sections[b.i]
        const vp = this.book.rendition?.viewport
        const aspect = b.aspect ?? (s.width && s.height ? s.width / s.height
            : vp?.width && vp?.height ? vp.width / vp.height : 0.7)
        const { cw, sh } = this.#dims
        const w = Math.floor(Math.min(cw, sh * 1.25 * aspect))
        return { w, h: Math.ceil(w / aspect), known: !!(b.aspect || (s.width && s.height) || (vp?.width && vp?.height)) }
    }

    // Height per byte of the blocks measured so far, used for the ones that are not yet.
    #ratio() {
        let bytes = 0, px = 0
        for (const b of this.#blocks) {
            if (!b.measured || this.#isFixed(b)) continue
            bytes += Math.max(1, this.book.sections[b.i].size ?? 1)
            px += b.h
        }
        return bytes > 20000 ? px / bytes : 250 / this.#dims.cw
    }

    #estimateAll() {
        const ratio = this.#ratio()
        for (const b of this.#blocks) {
            if (b.measured) continue
            if (this.#isFixed(b)) {
                const { h, known } = this.#fixedSize(b)
                if (known) this.#setMeasured(b, h, this.#findMarkers(b, null))
                else this.#setHeight(b, h)
            } else {
                const size = Math.max(1, this.book.sections[b.i].size ?? 1)
                this.#setHeight(b, Math.max(40, Math.round(size * ratio)))
            }
        }
    }

    #setHeight(b, h) {
        h = Math.max(1, Math.round(h))
        if (h === b.h) return
        b.h = h
        b.el.style.height = `${h}px`
        if (b.live?.iframe) b.live.iframe.style.height = `${h}px`
        this.#tops = null
        this.#pages = null
    }

    #setMeasured(b, h, markers) {
        b.measured = true
        b.markers = markers
        this.#pages = null
        // A change in a block above the screen is compensated by scroll anchoring, so the text
        // being read does not move.
        if (Math.abs(h - b.h) > 1) this.#setHeight(b, h)
    }

    #getTops() {
        if (!this.#tops) {
            let acc = 0
            this.#tops = this.#blocks.map(b => { const t = acc; acc += b.h; return t })
            this.#tops.total = acc
        }
        return this.#tops
    }

    // --- page map -----------------------------------------------------------------------------

    #getPages() {
        if (this.#pages) return this.#pages
        const tops = this.#getTops()
        const P = this.#dims.sh
        let pages = []
        this.#blocks.forEach((b, bi) => {
            if (this.#original) {
                const markers = b.markers ?? this.#estimatedMarkers(b)
                markers.forEach((m, k) => pages.push({ top: tops[bi] + Math.min(m.y, b.h - 1), label: m.label, b: bi, k }))
            } else {
                // One screen per page; a sliver of a few px at the end doesn't make a new one.
                const n = Math.max(1, Math.ceil((b.h - 4) / P))
                for (let j = 0; j < n; j++) pages.push({ top: tops[bi] + j * P, label: null, b: bi, k: j })
            }
        })
        pages.sort((a, b) => a.top - b.top)
        // Anything before the book's first numbered page (a cover, say) is a page of its own.
        if (!pages.length || pages[0].top > 0) pages.unshift({ top: 0, label: '', b: 0, k: -1 })
        if (!this.#original) pages.forEach((p, n) => { p.label = String(n + 1) })
        this.#pages = pages
        return pages
    }

    #pageIndexAt(y) {
        const pages = this.#getPages()
        let lo = 0, hi = pages.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (pages[mid].top <= y) lo = mid
            else hi = mid - 1
        }
        return lo
    }

    #blockIndexAt(y) {
        const tops = this.#getTops()
        let lo = 0, hi = this.#blocks.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (tops[mid] <= y) lo = mid
            else hi = mid - 1
        }
        return lo
    }

    #blockFor(index) {
        if (this.#blockOf.has(index)) return this.#blockOf.get(index)
        return this.#blocks.find(b => b.i >= index) ?? this.#blocks[this.#blocks.length - 1]
    }

    // --- position (derived from the scroll position) -------------------------------------------

    get scrollY() { return this.#scroller.scrollTop }

    progress() {
        if (!this.#blocks.length) return null
        const pages = this.#getPages()
        const tops = this.#getTops()
        const y = this.#scroller.scrollTop
        const k = this.#pageIndexAt(y + 1)
        const page = pages[k]
        const nextTop = pages[k + 1]?.top ?? tops.total
        const b = this.#blocks[this.#blockIndexAt(y + 1)]
        return {
            index: b.i,
            page: k,
            label: page.label,
            pages: pages.length,
            lastLabel: pages[pages.length - 1].label,
            // The book's own page numbers are known up front; screen pages only once measured.
            exact: this.#original || this.#blocks.every(b => b.measured),
            original: this.#original,
            fraction: pages.length > 1 ? k / (pages.length - 1) : 0,
            // Where on the current page the screen is: px from the page's top, and its height.
            pageOffset: Math.max(0, y - page.top),
            pageHeight: Math.max(1, nextTop - page.top),
            atEnd: y + this.#dims.sh >= tops.total - 2,
        }
    }

    pageLabel(k) { return this.#getPages()[k]?.label ?? '' }

    /** The page a saved location falls on (for the "back to page" marker). */
    locate(loc) {
        if (!loc) return null
        const b = this.#blockFor(loc.index)
        const bi = this.#blocks.indexOf(b)
        let y = (loc.sectionFraction ?? 0) * b.h
        if (b.live?.doc && loc.path) y = this.#yOfPath(b, loc.path, loc.offset) + (loc.dy ?? 0)
        const k = this.#pageIndexAt(this.#getTops()[bi] + y + 1)
        const pages = this.#getPages()
        return { page: k, label: pages[k].label, fraction: pages.length > 1 ? k / (pages.length - 1) : 0 }
    }

    /** Position of a TOC entry in the strip (exact once its section is loaded). */
    positionOf(index, anchor) {
        const b = this.#blockOf.get(index)
        if (!b) return null
        let y = this.#getTops()[this.#blocks.indexOf(b)]
        if (anchor && b.live?.doc) {
            try { y += topOf(b.live.doc, anchor(b.live.doc)) } catch {}
        }
        return y
    }

    /** A location that survives re-layout and is stored with the book. */
    getLocation() {
        if (!this.#blocks.length) return null
        const y = this.#scroller.scrollTop
        const bi = this.#blockIndexAt(y + 1)
        const b = this.#blocks[bi]
        const yIn = y - this.#getTops()[bi]
        const p = this.progress()
        const loc = { index: b.i, fraction: p.fraction, sectionFraction: b.h ? yIn / b.h : 0 }
        if (b.live?.doc) {
            const pos = this.#textAt(b, yIn)
            if (pos) {
                loc.path = nodePath(b.live.doc.body, pos.node)
                loc.offset = pos.offset
                // How far above the screen's top edge that character starts, to restore it exactly.
                loc.dy = Math.round(yIn - pos.top)
            }
        }
        if (this.book.pdf) loc.pdfPage = Number(p.label) || this.book.sections[b.i].pages?.[0] || this.book.sections[b.i].pdfPage
        return loc
    }

    /** Size (pt) of the current section's main text before any text size setting. */
    baseTextSize() {
        const y = this.#scroller.scrollTop
        const b = this.#blocks[this.#blockIndexAt(y + 1)]
        return b?.live?.doc?.brBaseTextSize ?? this.#blocks.find(b => b.live?.doc)?.live.doc.brBaseTextSize ?? null
    }

    // First character whose line reaches below `yIn` (binary search over text nodes).
    #textAt(b, yIn) {
        const doc = b.live.doc
        if (!b.live.textNodes) {
            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT,
                { acceptNode: n => n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT })
            const nodes = []
            while (walker.nextNode()) nodes.push(walker.currentNode)
            b.live.textNodes = nodes
        }
        const nodes = b.live.textNodes
        if (!nodes.length) return null
        const sy = doc.defaultView.scrollY
        const range = doc.createRange()
        const bottomOf = node => {
            range.selectNodeContents(node)
            const rects = range.getClientRects()
            return rects.length ? rects[rects.length - 1].bottom + sy : -Infinity
        }
        let lo = 0, hi = nodes.length - 1, found = -1
        while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (bottomOf(nodes[mid]) > yIn) { found = mid; hi = mid - 1 } else lo = mid + 1
        }
        if (found < 0) return null
        const node = nodes[found]
        let a = 0, z = node.length - 1, offset = 0, top = null
        while (a <= z) {
            const mid = (a + z) >> 1
            range.setStart(node, mid)
            range.setEnd(node, mid + 1)
            const r = range.getClientRects()[0]
            if (!r || r.bottom + sy > yIn) { offset = mid; if (r) top = r.top + sy; z = mid - 1 } else a = mid + 1
        }
        if (top == null) {
            range.setStart(node, offset)
            range.setEnd(node, Math.min(offset + 1, node.length))
            top = (range.getClientRects()[0]?.top ?? yIn) + sy
        }
        return { node, offset, top }
    }

    #yOfPath(b, path, offset) {
        const doc = b.live?.doc
        if (!doc) return 0
        const node = resolvePath(doc.body, path)
        try {
            const range = doc.createRange()
            if (node.nodeType === 3) {
                const o = Math.min(offset ?? 0, Math.max(0, node.length - 1))
                range.setStart(node, o)
                range.setEnd(node, Math.min(o + 1, node.length))
            } else range.selectNode(node)
            return topOf(doc, range)
        } catch { return 0 }
    }

    // --- navigation ---------------------------------------------------------------------------

    // Every jump resolves its target to a position in the strip only after the target block is
    // loaded and measured, then sets the scroll position once. Only the latest jump wins.
    async #navigate(resolve) {
        await this.#ready
        const token = ++this.#navToken
        const slow = setTimeout(() => this.dispatchEvent(new CustomEvent('loading', { detail: true })), 250)
        try {
            const y = await resolve()
            if (token !== this.#navToken || y == null) return
            this.#keyTarget = null
            this.#scroller.scrollTop = Math.round(y)
            this.#update()
        } catch (e) {
            console.error(e)
            this.dispatchEvent(new CustomEvent('error', { detail: e }))
        } finally {
            clearTimeout(slow)
            this.dispatchEvent(new CustomEvent('loading', { detail: false }))
            this.#scheduleMeasure()
        }
    }

    /**
     * Jump to a location: { index } plus one of anchor, path/offset/dy, sectionFraction,
     * or end: true.
     */
    goTo(target) {
        return this.#navigate(async () => {
            if (target.end) {
                const last = this.#blocks[this.#blocks.length - 1]
                await this.#load(last)
                return Math.max(0, this.#getTops().total - this.#dims.sh)
            }
            const b = this.#blockFor(target.index ?? 0)
            await this.#load(b)
            const top = this.#getTops()[this.#blocks.indexOf(b)]
            if (target.anchor && b.live?.doc) {
                const el = await (typeof target.anchor === 'function' ? target.anchor(b.live.doc) : target.anchor)
                return top + topOf(b.live.doc, el)
            }
            if (target.path && b.live?.doc) return top + this.#yOfPath(b, target.path, target.offset) + (target.dy ?? 0)
            if (target.sectionFraction != null) return top + target.sectionFraction * b.h
            return top
        })
    }

    async goToHref(href) {
        const resolved = await this.book.resolveHref?.(href)
        if (!resolved || resolved.index == null || resolved.index < 0) return false
        await this.goTo({ index: resolved.index, anchor: resolved.anchor })
        return true
    }

    /** Jump to the top of page k of the page map (the scroller snaps to pages). */
    goToPage(k) {
        const pages = this.#getPages()
        const page = pages[Math.max(0, Math.min(pages.length - 1, k))]
        return this.#navigate(async () => {
            const b = this.#blocks[page.b]
            await this.#load(b)
            // Loading may have measured the block, which moves its pages; find the same one again.
            const fresh = this.#getPages()
            const same = fresh.find(p => p.b === page.b && p.k === page.k)
                ?? fresh.filter(p => p.b === page.b).pop()
            return same ? same.top : this.#getTops()[page.b]
        })
    }

    next() {
        const p = this.progress()
        if (p) return this.goToPage(p.page + 1)
    }

    prev() {
        const p = this.progress()
        if (p) return this.goToPage(p.pageOffset > 2 ? p.page : p.page - 1)
    }

    /**
     * Smooth scrolling by keyboard. Repeated presses move one target further instead of
     * restarting, and scrolling any other way (wheel, touch, a jump) takes over at once.
     */
    scrollStep(dy) {
        const s = this.#scroller
        const max = s.scrollHeight - s.clientHeight
        const a = this.#keyTarget
        const to = Math.max(0, Math.min(max, (a ? a.target : s.scrollTop) + dy))
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) { s.scrollTop = to; return }
        if (a) { a.target = to; return }
        this.#keyTarget = { target: to, expected: s.scrollTop, last: performance.now() }
        this.#animate()
    }

    #animate() {
        const a = this.#keyTarget, s = this.#scroller
        if (!a) return
        // Someone else moved the strip: stop rather than fight them.
        if (Math.abs(s.scrollTop - a.expected) > 2) { this.#keyTarget = null; return }
        const now = performance.now()
        const dt = Math.min(64, now - a.last)
        a.last = now
        const diff = a.target - s.scrollTop
        if (Math.abs(diff) < 1) { this.#keyTarget = null; return }
        // Ease out: each frame covers a share of what is left (about 90% in 140 ms).
        let step = diff * (1 - Math.exp(-dt / 60))
        if (Math.abs(step) < 1) step = Math.sign(diff) * Math.min(1, Math.abs(diff))
        s.scrollTop += step
        a.expected = s.scrollTop
        nextFrame(() => this.#animate())
    }
    scrollLines(n) { this.scrollStep(n * Math.round(this.#dims.sh * 0.12)) }
    scrollScreens(n) { this.scrollStep(n * Math.round(this.#dims.sh * 0.88)) }

    // --- loading blocks near the screen ---------------------------------------------------------

    #queueUpdate() {
        if (this.#updateQueued) return
        this.#updateQueued = true
        nextFrame(() => {
            this.#updateQueued = false
            this.#update()
        })
    }

    #update() {
        if (!this.#blocks.length) return
        const tops = this.#getTops()
        const y = this.#scroller.scrollTop, sh = this.#dims.sh
        const near = [], far = []
        this.#blocks.forEach((b, bi) => {
            const top = tops[bi], bottom = top + b.h
            if (bottom > y - sh * 1.5 && top < y + sh * 2.5) near.push(b)
            else if ((bottom < y - sh * 10 || top > y + sh * 12) && (b.live || b.loading)) far.push(b)
        })
        const mid = y + sh / 2
        near.sort((a, b) => Math.abs(tops[this.#blocks.indexOf(a)] - mid) - Math.abs(tops[this.#blocks.indexOf(b)] - mid))
        for (const b of near) this.#load(b)
        for (const b of far) this.#unload(b)
        this.dispatchEvent(new CustomEvent('relocate', { detail: this.progress() }))
    }

    #load(b) {
        if (b.live) return Promise.resolve()
        if (b.loading) return b.loading
        const gen = this.#gen
        const loading = (async () => {
            try {
                if (this.#isFixed(b)) await this.#loadFixed(b, gen)
                else await this.#loadFlow(b, gen)
            } catch (e) {
                console.error(e)
                this.dispatchEvent(new CustomEvent('error', { detail: e }))
            }
        })()
        b.loading = loading
        // A load that was abandoned (unloaded, or a relayout started) must not clear a newer one.
        loading.finally(() => { if (b.loading === loading) b.loading = null })
        return loading
    }

    async #loadFlow(b, gen) {
        const url = await this.book.sections[b.i].load()
        const iframe = makeIframe()
        iframe.style.width = `${this.#dims.W}px`
        iframe.style.height = `${b.h}px`
        iframe.style.visibility = 'hidden'
        b.el.replaceChildren(iframe)
        await loadIframe(iframe, url)
        const stale = () => gen !== this.#gen || !iframe.isConnected
        if (stale()) { iframe.remove(); return }
        const doc = iframe.contentDocument
        if (!doc?.documentElement) throw new Error('Section could not be loaded')
        this.#setupDocument(doc, b.i)
        const h = await layoutFlow(doc, this.#dims, this.#settings)
        if (stale()) { iframe.remove(); return }
        b.live = { iframe, doc, textNodes: null }
        iframe.style.visibility = ''
        iframe.style.height = `${h}px`
        this.#setMeasured(b, h, this.#findMarkers(b, doc))
        // Late changes (an image that finished loading after all, a web font) resize the block.
        const ro = new doc.defaultView.ResizeObserver(() => {
            if (b.live?.doc !== doc) return
            const nh = measureFlow(doc)
            if (Math.abs(nh - b.h) > 1) {
                b.live.textNodes = null
                this.#setMeasured(b, nh, this.#findMarkers(b, doc))
                this.#queueUpdate()
            }
        })
        ro.observe(doc.body)
        b.live.ro = ro
        this.#queueUpdate()
    }

    async #loadFixed(b, gen) {
        const section = this.book.sections[b.i]
        const { w, h } = this.#fixedSize(b)
        const wrap = document.createElement('div')
        wrap.className = 'fixed-wrap'
        b.el.replaceChildren(wrap)
        const el = section.render ? await section.render(w, h) : await this.#renderFixedDoc(b, wrap, w)
        if (gen !== this.#gen || !wrap.isConnected) return
        const t = THEMES[this.#settings.theme] ?? THEMES.light
        const invert = t.dark && (this.#settings.invertFixed === 'always'
            || (this.#settings.invertFixed === 'auto' && section.imageRatio != null && section.imageRatio < 0.25))
        el.classList.toggle('inverted', !!invert)
        wrap.replaceChildren(el)
        b.live = { el, doc: el.querySelector('iframe')?.contentDocument ?? null, fixed: true }
        this.#setMeasured(b, Math.ceil(parseFloat(el.style.height) || el.getBoundingClientRect().height || h), this.#findMarkers(b, null))
        this.#queueUpdate()
    }

    async #renderFixedDoc(b, wrap, maxW) {
        const url = await this.book.sections[b.i].load()
        const el = document.createElement('div')
        el.className = 'fixed-page'
        const iframe = makeIframe()
        iframe.style.width = '1000px'
        iframe.style.height = '1400px'
        el.append(iframe)
        wrap.append(el)
        await loadIframe(iframe, url)
        const doc = iframe.contentDocument
        let w, h
        const meta = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? ''
        const mw = meta.match(/width\s*=\s*([\d.]+)/i), mh = meta.match(/height\s*=\s*([\d.]+)/i)
        if (mw && mh) { w = Number(mw[1]); h = Number(mh[1]) }
        else if (this.book.rendition?.viewport?.width) {
            w = Number(this.book.rendition.viewport.width); h = Number(this.book.rendition.viewport.height)
        }
        const imgs = doc.images
        if ((!w || !h) && imgs.length === 1) {
            await imgs[0].decode().catch(() => {})
            w = imgs[0].naturalWidth; h = imgs[0].naturalHeight
            imgs[0].style.cssText += ';display:block;width:100%;height:100%;object-fit:contain'
            doc.body.style.margin = '0'
        }
        const svg = doc.querySelector('body > svg, body > div > svg')
        if ((!w || !h) && svg?.viewBox?.baseVal?.width) { w = svg.viewBox.baseVal.width; h = svg.viewBox.baseVal.height }
        if (!w || !h) { w = doc.documentElement.scrollWidth || 1000; h = doc.documentElement.scrollHeight || 1400 }
        b.aspect = w / h
        const fit = this.#fixedSize(b)
        const scale = Math.min(maxW, fit.w) / w
        iframe.style.width = `${w}px`
        iframe.style.height = `${h}px`
        iframe.style.transform = `scale(${scale})`
        el.style.width = `${w * scale}px`
        el.style.height = `${h * scale}px`
        doc.documentElement.style.overflow = 'hidden'
        this.#setupDocument(doc, b.i)
        return el
    }

    #unload(b) {
        b.live?.ro?.disconnect()
        b.live = null
        b.loading = null
        b.el.replaceChildren()
    }

    #setupDocument(doc, index) {
        const html = doc.documentElement
        const lang = this.book.metadata?.language
        if (!html.lang && typeof lang === 'string') html.lang = lang
        else if (!html.lang && Array.isArray(lang) && lang[0]) html.lang = lang[0]
        doc.addEventListener('click', e => this.#onDocClick(e, doc, index))
        doc.addEventListener('keydown', e => this.dispatchEvent(new CustomEvent('doc-keydown', { detail: e })))
    }

    #onDocClick(e, doc, index) {
        const a = e.target.closest?.('a[href]')
        if (a) {
            e.preventDefault()
            this.dispatchEvent(new CustomEvent('link', { detail: { a, doc, index, event: e } }))
            return
        }
        if (doc.getSelection()?.toString()) return
        const frame = doc.defaultView.frameElement
        const r = frame.getBoundingClientRect(), sr = this.#stage.getBoundingClientRect()
        const scale = r.width / frame.offsetWidth
        this.dispatchEvent(new CustomEvent('tap', {
            detail: { x: r.left - sr.left + e.clientX * scale, y: r.top - sr.top + e.clientY * scale, width: sr.width, height: sr.height },
        }))
    }

    // --- relayout -----------------------------------------------------------------------------

    async relayout() {
        await this.#ready
        if (!this.#blocks.length) return
        const gen = ++this.#gen
        this.#measureGen++
        // Where we are, as text, so the same words are at the top after the new layout.
        const loc = this.getLocation()
        this.#dims = this.#computeDims()
        for (const b of this.#blocks) {
            b.measured = false
            b.markers = null
            if (b.live?.fixed || b.loading) this.#unload(b)
        }
        for (const b of this.#blocks) {
            if (!b.live) continue
            const h = await layoutFlow(b.live.doc, this.#dims, this.#settings)
            if (gen !== this.#gen) return
            b.live.iframe.style.width = `${this.#dims.W}px`
            b.live.textNodes = null
            this.#setMeasured(b, h, this.#findMarkers(b, b.live.doc))
        }
        this.#tops = null
        this.#pages = null
        this.#estimateAll()
        if (loc) await this.goTo(loc)
    }

    // --- background measuring ------------------------------------------------------------------

    #scheduleMeasure() {
        clearTimeout(this.#measureTimer)
        this.#measureTimer = setTimeout(() => this.#measureAll(), 400)
    }

    async #measureAll() {
        const gen = ++this.#measureGen
        const dims = this.#dims
        let host = this.measureHost
        if (!host) {
            host = this.measureHost = document.createElement('div')
            host.style.cssText = 'position:fixed;left:-200000px;top:0;visibility:hidden;pointer-events:none;overflow:hidden'
            document.body.append(host)
        }
        host.style.width = `${dims.W}px`
        host.style.height = `${dims.sh}px`
        // Nearest blocks first, so the part of the book you are in settles soonest.
        const here = this.#blockIndexAt(this.#scroller.scrollTop + 1)
        const order = this.#blocks.map((b, bi) => [b, Math.abs(bi - here)]).sort((a, b) => a[1] - b[1]).map(x => x[0])
        let lastEmit = performance.now()
        for (const b of order) {
            if (gen !== this.#measureGen) return
            if (b.measured || b.live || this.#isFixed(b)) continue
            await idle()
            if (gen !== this.#measureGen) return
            const iframe = makeIframe()
            iframe.style.cssText = `width:${dims.W}px;height:${dims.sh}px;border:0`
            host.replaceChildren(iframe)
            try {
                await loadIframe(iframe, await this.book.sections[b.i].load())
                if (gen !== this.#measureGen) return
                const doc = iframe.contentDocument
                const h = await layoutFlow(doc, dims, this.#settings)
                if (gen !== this.#measureGen) return
                if (!b.measured) this.#setMeasured(b, h, this.#findMarkers(b, doc))
            } catch (e) {
                console.warn('Could not measure section', b.i, e)
                b.measured = true
            }
            if (performance.now() - lastEmit > 400) {
                lastEmit = performance.now()
                this.#estimateAll()
                this.dispatchEvent(new CustomEvent('relocate', { detail: this.progress() }))
            }
        }
        host.replaceChildren()
        this.#estimateAll()
        this.dispatchEvent(new CustomEvent('relocate', { detail: this.progress() }))
    }

    destroy() {
        this.#gen++
        this.#measureGen++
        this.#navToken++
        clearTimeout(this.#measureTimer)
        clearTimeout(this.#resizeTimer)
        this.resizeObserver.disconnect()
        for (const b of this.#blocks) b.live?.ro?.disconnect()
        this.#scroller.remove()
        this.measureHost?.remove()
    }
}
