// Real-time paginator.
//
// Reflowable sections are rendered in a sandboxed iframe and split into pages with CSS columns
// sized to the current screen, zoom level and font settings. Before splitting, "visual units"
// (figures, charts, tables, SVG, maths, image + caption groups) are measured: a unit that fits on
// a page is never split; one slightly too large is scaled down to fit a page; one far too large
// (a very long table) is allowed to break, because shrinking it would make it unreadable. A short
// section made of such units (a chart page with notes, say) is kept together as a single page.
//
// Fixed sections (PDF pages kept in their original construction, pre-paginated EPUB/KF8,
// comics) are shown whole, scaled to fit, side by side when two pages fit on screen.
//
// Every layout change (window size, zoom, fonts, margins…) re-splits the pages immediately
// and keeps the reader on the same text.

import { THEMES, fontStack } from './settings.js'

const ATOMIC_SELECTOR = [
    'figure', 'table', 'svg', 'pre', 'math', 'video', 'canvas', 'object', 'dl.equation',
    '[class*="figure" i]', '[class*="chart" i]', '[class*="graph" i]', '[class*="diagram" i]',
    '[class*="equation" i]', '[class*="formula" i]', '[class*="table" i]:not(body):not(html)',
    '[*|type~="figure"]', '[*|type~="table"]', '[role="figure"]', '[role="table"]',
].join(',')
const TABLE_LIKE = 'table, pre, [class*="table" i]'

const wait = ms => new Promise(r => setTimeout(r, ms))
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()))
const idle = () => new Promise(r => (window.requestIdleCallback ?? setTimeout)(() => r(), { timeout: 200 }))

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

const layoutCSS = (d, s, book) => {
    const font = fontStack(s)
    const pageH = d.H - 2 * d.mV
    const lh = Number(s.lineHeight)
    const alignSel = 'p:not([class*="center" i]):not([class*="right" i]):not([style*="text-align" i]):not([align]), li, dd, blockquote'
    return `
html {
    width: ${d.W}px !important; height: ${d.H}px !important;
    min-width: 0 !important; min-height: 0 !important; max-width: none !important; max-height: none !important;
    margin: 0 !important; padding: ${d.mV}px ${d.mH}px !important; box-sizing: border-box !important;
    column-count: ${d.n} !important; column-gap: ${2 * d.mH}px !important; column-fill: auto !important;
    column-width: auto !important; column-rule: none !important;
    overflow: visible !important; direction: ltr !important; writing-mode: horizontal-tb !important;
    -webkit-text-size-adjust: none; text-size-adjust: none;
}
html.br-measure { column-count: auto !important; height: auto !important; width: ${d.cw + 2 * d.mH}px !important; }
body {
    height: auto !important; min-height: 0 !important; max-height: none !important;
    width: auto !important; max-width: none !important; overflow: visible !important;
    position: static !important; float: none !important; column-count: auto !important; columns: auto !important;
    ${book.dir === 'rtl' ? 'direction: rtl;' : ''}
}
img, video, canvas, object { max-width: 100% !important; max-height: ${pageH}px !important; object-fit: contain; box-sizing: border-box; }
svg { max-width: 100% !important; max-height: ${pageH}px !important; }
img, svg, video { break-inside: avoid; }
[data-br-atomic] { break-inside: avoid !important; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; }
p { orphans: 2; widows: 2; }
aside[*|type~="footnote"], aside[*|type~="note"], aside[role="doc-footnote"] { display: none !important; }
#br-end { display: block !important; height: 0 !important; margin: 0 !important; padding: 0 !important; border: 0 !important; float: none !important; clear: both; }
html.br-image-page { column-count: 1 !important; }
html.br-image-page body { height: ${pageH}px !important; margin: 0 !important; padding: 0 !important;
    display: flex !important; flex-direction: column; align-items: center; justify-content: center; }
html.br-image-page body > * { margin: 0 !important; max-height: ${pageH}px; max-width: 100%; }
html.br-image-page svg { height: ${pageH}px !important; width: 100% !important; }
html.br-page-mode body { break-inside: avoid; }
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

/**
 * Lays out a reflowable document for the given dimensions; returns the number of pages
 * (columns) and views (screens).
 */
export const layoutFlow = async (doc, d, s, book) => {
    const html = doc.documentElement
    if (!doc.body) return { pages: 1, views: 1 }
    let style = doc.getElementById('br-style')
    if (!style) {
        style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style')
        style.id = 'br-style'
            ; (doc.head ?? html).append(style)
    }
    // Our style must come last to win over the book's own stylesheets.
    if (style.nextElementSibling) style.parentNode.append(style)
    style.textContent = layoutCSS(d, s, book)
    let end = doc.getElementById('br-end')
    if (!end) {
        end = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div')
        end.id = 'br-end'
    }
    doc.body.append(end)

    await waitForImages(doc)
    try { await doc.fonts?.ready } catch {}

    // Reset previous fitting.
    for (const el of doc.querySelectorAll('[data-br-zoom]')) { el.style.removeProperty('zoom'); el.removeAttribute('data-br-zoom') }
    for (const el of doc.querySelectorAll('[data-br-atomic]')) el.removeAttribute('data-br-atomic')
    html.classList.remove('br-page-mode', 'br-image-page')
    doc.body.style.removeProperty('zoom')
    applyTextSize(doc, s)

    const t = THEMES[s.theme] ?? THEMES.light
    for (const img of doc.images) {
        if (t.dark && img.naturalWidth > 64 && img.naturalHeight > 64) img.setAttribute('data-br-imgbg', '')
        else img.removeAttribute('data-br-imgbg')
    }

    const pageH = d.H - 2 * d.mV - 2
    const pageW = d.cw
    html.classList.add('br-measure')
    const body = doc.body
    const textLength = body.textContent.replace(/\s+/g, '').length
    const visuals = body.querySelectorAll('img, svg, video, canvas')

    if (textLength < 30 && visuals.length === 1) {
        // A page that is just a picture (cover, plate): centre it on its own page.
        // Shown across the whole screen, even in two-page mode.
        html.classList.remove('br-measure')
        html.classList.add('br-image-page')
        return { pages: d.n, views: 1 }
    } else {
        const bodyRect = body.getBoundingClientRect()
        const units = visualUnits(doc)
        const hasVisual = units.length > 0
        const bodyH = body.scrollHeight
        const pageScale = Math.min(pageH / bodyH, pageW / Math.max(bodyRect.width, body.scrollWidth))
        if (hasVisual && bodyH > pageH && pageScale >= 0.62) {
            // Short section of charts/tables with notes: keep its construction on one page.
            body.style.setProperty('zoom', pageScale.toFixed(4), 'important')
            body.setAttribute('data-br-zoom', '')
            html.classList.add('br-page-mode')
        } else {
            const measured = units.map(el => {
                const r = el.getBoundingClientRect()
                return { el, h: r.height, w: Math.max(r.width, el.scrollWidth) }
            })
            for (const { el, h, w } of measured) {
                if (h < 4) continue
                const tableLike = el.matches(TABLE_LIKE) || !!el.querySelector('table')
                const minScale = tableLike ? 0.55 : 0.3
                const scale = Math.min(1, pageH / h, pageW / w)
                if (scale > 0.995) el.setAttribute('data-br-atomic', '')
                else if (scale >= minScale) {
                    el.style.setProperty('zoom', scale.toFixed(4), 'important')
                    el.setAttribute('data-br-zoom', '')
                    el.setAttribute('data-br-atomic', '')
                } else if (pageW / w < 0.995) {
                    // Too tall to shrink onto one page: let it break, but make it fit the width.
                    el.style.setProperty('zoom', Math.max(pageW / w, minScale).toFixed(4), 'important')
                    el.setAttribute('data-br-zoom', '')
                }
            }
        }
        html.classList.remove('br-measure')
    }
    return countPages(doc, d)
}

const countPages = (doc, d) => {
    const end = doc.getElementById('br-end')
    const colW = d.cw + 2 * d.mH
    let right = end.getBoundingClientRect().left
    // The end marker can sit at the top of an empty column; use the real content edge when
    // the last child ends earlier.
    const last = end.previousElementSibling
    if (last) {
        const rects = last.getClientRects()
        const lr = rects[rects.length - 1]
        if (lr && lr.width && lr.right < right) right = Math.max(lr.left, lr.right - 1)
    }
    const col = Math.max(0, Math.floor((right - d.mH + 1) / colW))
    const pages = col + 1
    return { pages, views: Math.ceil(pages / d.n) }
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

// ---------------------------------------------------------------------------------------------

export class Paginator extends EventTarget {
    #stage
    #settings
    #display = null
    #token = 0
    #dims
    #counts = []
    #counterGen = 0
    #counterTimer
    #resizeTimer
    #textNodes = null
    #pendingNav = null
    #navigating = false
    book
    view = 0

    constructor(stage, book, settings) {
        super()
        this.#stage = stage
        this.book = book
        this.#settings = settings
        this.#dims = this.#computeDims()
        this.#counts = new Array(book.sections.length).fill(null)
        this.resizeObserver = new ResizeObserver(() => {
            clearTimeout(this.#resizeTimer)
            this.#resizeTimer = setTimeout(() => this.relayout(), 120)
        })
        this.resizeObserver.observe(stage)
    }

    get index() { return this.#display?.index ?? -1 }
    get display() { return this.#display }
    get counts() { return this.#counts }

    #computeDims() {
        const s = this.#settings
        const rect = this.#stage.getBoundingClientRect()
        const sw = Math.max(200, rect.width), sh = Math.max(200, rect.height)
        const z = Math.max(0.25, s.zoom / 100)
        const W = sw / z, H = sh / z
        const mV = Math.min(s.marginV / z, H * 0.2)
        // Side margins are a percentage of each page's width, so they scale with the screen.
        const pct = Math.max(0, Number(s.marginSide) || 0) / 100
        const n = s.spread === 'double' ? 2 : s.spread === 'single' ? 1
            : (sw >= 900 && sw / sh > 1.15 && (W / 2) * (1 - 2 * pct) >= 340) ? 2 : 1
        let mH = pct * W / n
        if (n === 2) mH = Math.max(mH, 14 / z)
        // Wide margins are fine as long as a column stays readable (≥ 260 CSS px).
        mH = Math.max(0, Math.min(mH, (W / n - 260) / 2))
        const cw = (W - 2 * n * mH) / n
        return { sw, sh, z, W, H, mH, mV, n, cw }
    }

    // --- navigation ---------------------------------------------------------------------------

    isFixed(i) {
        const s = this.book.sections[i]
        return !!(s && (s.render || s.fixed))
    }
    isLinear(i) { return this.book.sections[i] && this.book.sections[i].linear !== 'no' }

    #fixedGroup(i) {
        if (this.#dims.n !== 2) return [i]
        let start = i
        while (start > 0 && this.isFixed(start - 1)) start--
        const offset = i - start
        let first
        if (start === 0) first = offset === 0 ? 0 : 1 + Math.floor((offset - 1) / 2) * 2
        else first = start + Math.floor(offset / 2) * 2
        if (start === 0 && first === 0) return [0]
        return this.isFixed(first + 1) && first + 1 < this.book.sections.length ? [first, first + 1] : [first]
    }

    #nextIndex(from) {
        for (let i = from + 1; i < this.book.sections.length; i++) if (this.isLinear(i)) return i
        return null
    }
    #prevIndex(from) {
        for (let i = from - 1; i >= 0; i--) if (this.isLinear(i)) return i
        return null
    }

    async next() {
        const d = this.#display
        if (!d) return
        if (d.type === 'flow' && this.view < d.views - 1) return this.#setView(this.view + 1, true)
        const i = this.#nextIndex(d.type === 'fixed' ? Math.max(...d.indices) : d.index)
        if (i != null) return this.#navigate({ index: i, view: 0 })
    }

    async prev() {
        const d = this.#display
        if (!d) return
        if (d.type === 'flow' && this.view > 0) return this.#setView(this.view - 1, true)
        const i = this.#prevIndex(d.type === 'fixed' ? Math.min(...d.indices) : d.index)
        if (i != null) return this.#navigate({ index: i, end: true })
    }

    async goTo(target) {
        return this.#navigate(target)
    }

    async goToHref(href) {
        const resolved = await this.book.resolveHref?.(href)
        if (!resolved || resolved.index == null || resolved.index < 0) return false
        await this.#navigate({ index: resolved.index, anchor: resolved.anchor })
        return true
    }

    async goToFraction(fraction) {
        const { index, within } = this.#sectionAtFraction(fraction)
        return this.#navigate({ index, fraction: within })
    }

    // Serialises navigations: only the latest pending one runs after the current finishes.
    async #navigate(target) {
        this.#pendingNav = target
        if (this.#navigating) return
        this.#navigating = true
        try {
            while (this.#pendingNav) {
                const t = this.#pendingNav
                this.#pendingNav = null
                await this.#show(t)
            }
        } finally {
            this.#navigating = false
        }
    }

    async #show(target) {
        const token = ++this.#token
        const dims = this.#dims
        let index = Math.max(0, Math.min(this.book.sections.length - 1, target.index ?? 0))
        const cur = this.#display
        const alreadyShown = cur && (cur.type === 'flow' ? cur.index === index : cur.indices.includes(index))
            && cur.dims === dims
        let display = cur
        if (!alreadyShown) {
            this.dispatchEvent(new CustomEvent('loading', { detail: true }))
            try {
                display = this.isFixed(index)
                    ? await this.#createFixed(this.#fixedGroup(index), dims)
                    : await this.#createFlow(index, dims)
            } catch (e) {
                console.error(e)
                this.dispatchEvent(new CustomEvent('loading', { detail: false }))
                this.dispatchEvent(new CustomEvent('error', { detail: e }))
                // Skip an unreadable section instead of getting stuck on it.
                if (token === this.#token) {
                    const next = target.end ? this.#prevIndex(index) : this.#nextIndex(index)
                    if (next != null && next !== index) return this.#show({ ...target, index: next })
                }
                return
            }
            this.dispatchEvent(new CustomEvent('loading', { detail: false }))
            if (token !== this.#token) { display.destroy(); return }
        }
        let view = 0
        if (display.type === 'flow') {
            if (target.end) view = display.views - 1
            else if (target.anchor) view = await this.#viewOfAnchor(display, target.anchor)
            else if (target.path) view = this.#viewOfPath(display, target.path, target.offset)
            else if (target.fraction != null) view = Math.min(display.views - 1, Math.floor(target.fraction * display.views))
            else if (target.view != null) view = Math.min(display.views - 1, target.view)
            if (target.view === 'last') view = display.views - 1
        }
        if (display !== cur) {
            this.#textNodes = null
            display.layer.style.visibility = ''
            display.layer.classList.add('fade-in')
            this.#display = display
            if (cur) cur.destroy()
            if (display.type === 'flow') this.#counts[display.index] = display.pages
        }
        this.#setView(view, false)
        this.#prefetch()
        this.#scheduleCount()
    }

    #setView(view, animate) {
        const d = this.#display
        if (!d) return
        this.view = Math.max(0, Math.min(view, (d.views ?? 1) - 1))
        if (d.type === 'flow') {
            const anim = animate && this.#settings.animate
            d.iframe.classList.toggle('animate', !!anim)
            d.iframe.style.transform = `scale(${d.dims.z}) translateX(${-this.view * d.dims.W}px)`
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail: this.progress() }))
    }

    #prefetch() {
        const d = this.#display
        const nextI = this.#nextIndex(d.type === 'fixed' ? Math.max(...d.indices) : d.index)
        for (const i of [nextI, this.#prevIndex(d.type === 'fixed' ? Math.min(...d.indices) : d.index)]) {
            if (i == null) continue
            const s = this.book.sections[i]
            if (s.prefetch) {
                const { w, h } = this.#fixedPageBox(this.#fixedGroup(i).length)
                s.prefetch(w, h)
            } else Promise.resolve().then(() => s.load?.()).catch(() => {})
        }
    }

    // --- displays -----------------------------------------------------------------------------

    #makeLayer() {
        const layer = document.createElement('div')
        layer.className = 'page-layer'
        layer.style.visibility = 'hidden'
        this.#stage.append(layer)
        return layer
    }

    async #createFlow(index, dims) {
        const section = this.book.sections[index]
        const url = await section.load()
        const layer = this.#makeLayer()
        const iframe = makeIframe()
        iframe.style.width = `${dims.W}px`
        iframe.style.height = `${dims.H}px`
        iframe.style.transform = `scale(${dims.z})`
        layer.append(iframe)
        try {
            await loadIframe(iframe, url)
            const doc = iframe.contentDocument
            if (!doc?.documentElement) throw new Error('Section could not be loaded')
            this.#setupDocument(doc, index)
            const { pages, views } = await layoutFlow(doc, dims, this.#settings, this.book)
            iframe.style.width = `${views * dims.W}px`
            return {
                type: 'flow', index, iframe, doc, layer, pages, views, dims,
                destroy: () => layer.remove(),
            }
        } catch (e) {
            layer.remove()
            throw e
        }
    }

    #fixedPageBox(count) {
        const d = this.#dims
        const pad = Math.min(this.#settings.marginV, 24)
        return { w: (d.sw - pad * 2) / count, h: d.sh - pad * 2 }
    }

    async #createFixed(indices, dims) {
        const layer = this.#makeLayer()
        const wrap = document.createElement('div')
        wrap.className = 'fixed-wrap'
        layer.append(wrap)
        const { w, h } = this.#fixedPageBox(indices.length)
        const t = THEMES[this.#settings.theme] ?? THEMES.light
        try {
            const els = await Promise.all(indices.map(async i => {
                const section = this.book.sections[i]
                const el = section.render ? await section.render(w, h) : await this.#renderFixedDoc(i, wrap, w, h)
                const invert = t.dark && (this.#settings.invertFixed === 'always'
                    || (this.#settings.invertFixed === 'auto' && section.imageRatio != null && section.imageRatio < 0.25))
                el.classList.toggle('inverted', !!invert)
                return el
            }))
            wrap.replaceChildren(...els)
            // Two-page spread: pages meet at the spine.
            if (els.length === 2) {
                els[0].style.marginLeft = 'auto'
                els[1].style.marginRight = 'auto'
            }
        } catch (e) {
            layer.remove()
            throw e
        }
        return {
            type: 'fixed', index: indices[0], indices, layer, views: 1, pages: indices.length, dims,
            destroy: () => layer.remove(),
        }
    }

    async #renderFixedDoc(index, wrap, maxW, maxH) {
        const section = this.book.sections[index]
        const url = await section.load()
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
        const scale = Math.min(maxW / w, maxH / h)
        iframe.style.width = `${w}px`
        iframe.style.height = `${h}px`
        iframe.style.transform = `scale(${scale})`
        el.style.width = `${w * scale}px`
        el.style.height = `${h * scale}px`
        doc.documentElement.style.overflow = 'hidden'
        this.#setupDocument(doc, index)
        return el
    }

    #setupDocument(doc, index) {
        const html = doc.documentElement
        const lang = this.book.metadata?.language
        if (!html.lang && typeof lang === 'string') html.lang = lang
        else if (!html.lang && Array.isArray(lang) && lang[0]) html.lang = lang[0]
        doc.addEventListener('click', e => this.#onDocClick(e, doc, index))
        doc.addEventListener('keydown', e => this.dispatchEvent(new CustomEvent('doc-keydown', { detail: e })))
        doc.addEventListener('wheel', e => this.dispatchEvent(new CustomEvent('doc-wheel', { detail: e })), { passive: false })
        doc.addEventListener('touchstart', e => this.dispatchEvent(new CustomEvent('doc-touchstart', { detail: e })), { passive: true })
        doc.addEventListener('touchend', e => this.dispatchEvent(new CustomEvent('doc-touchend', { detail: e })), { passive: true })
    }

    #onDocClick(e, doc, index) {
        const a = e.target.closest?.('a[href]')
        if (a) {
            e.preventDefault()
            this.dispatchEvent(new CustomEvent('link', { detail: { a, doc, index, event: e } }))
            return
        }
        if (doc.getSelection()?.toString()) return
        // Translate to stage coordinates for tap zones.
        const d = this.#display
        let x = e.clientX, y = e.clientY
        if (d?.type === 'flow' && d.doc === doc) {
            x = (e.clientX - this.view * d.dims.W) * d.dims.z
            y = e.clientY * d.dims.z
        } else {
            const frame = doc.defaultView.frameElement
            const r = frame.getBoundingClientRect(), sr = this.#stage.getBoundingClientRect()
            const scale = r.width / frame.offsetWidth
            x = r.left - sr.left + e.clientX * scale
            y = r.top - sr.top + e.clientY * scale
        }
        this.dispatchEvent(new CustomEvent('tap', { detail: { x, y, width: this.#dims.sw, height: this.#dims.sh } }))
    }

    // --- anchors ------------------------------------------------------------------------------

    #viewOfX(d, x) {
        return Math.max(0, Math.min(d.views - 1, Math.floor(x / d.dims.W)))
    }

    #viewOfRect(d, rects) {
        for (const r of rects) if (r.width || r.height) return this.#viewOfX(d, r.left + 1)
        return null
    }

    async #viewOfAnchor(d, anchor) {
        try {
            const target = await (typeof anchor === 'function' ? anchor(d.doc) : anchor)
            if (!target) return 0
            if (target instanceof d.doc.defaultView.Range) return this.#viewOfRect(d, target.getClientRects()) ?? 0
            if (typeof target === 'number') return 0
            for (let el = target; el; el = el.nextElementSibling ?? el.parentElement) {
                const v = this.#viewOfRect(d, el.getClientRects())
                if (v != null) return v
                if (el === d.doc.body) break
            }
        } catch (e) { console.warn(e) }
        return 0
    }

    #viewOfPath(d, path, offset) {
        const node = resolvePath(d.doc.body, path)
        try {
            const range = d.doc.createRange()
            if (node.nodeType === 3) {
                const o = Math.min(offset ?? 0, node.length)
                range.setStart(node, o)
                range.setEnd(node, Math.min(o + 1, node.length))
            } else range.selectNode(node)
            return this.#viewOfRect(d, range.getClientRects()) ?? 0
        } catch { return 0 }
    }

    // First text position visible in the current view (binary search over text nodes).
    #firstVisible() {
        const d = this.#display
        if (d?.type !== 'flow') return null
        if (!this.#textNodes) {
            const walker = d.doc.createTreeWalker(d.doc.body, NodeFilter.SHOW_TEXT,
                { acceptNode: n => n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT })
            const nodes = []
            while (walker.nextNode()) nodes.push(walker.currentNode)
            this.#textNodes = nodes
        }
        const nodes = this.#textNodes
        const range = d.doc.createRange()
        const endView = node => {
            range.selectNodeContents(node)
            const rects = range.getClientRects()
            for (let i = rects.length - 1; i >= 0; i--) if (rects[i].width) return this.#viewOfX(d, rects[i].left + 1)
            return -1
        }
        let lo = 0, hi = nodes.length - 1, found = -1
        while (lo <= hi) {
            const mid = (lo + hi) >> 1
            if (endView(nodes[mid]) >= this.view) { found = mid; hi = mid - 1 } else lo = mid + 1
        }
        if (found < 0) return null
        const node = nodes[found]
        // Find the first character of that node in this view.
        let a = 0, b = node.length - 1, offset = 0
        while (a <= b) {
            const mid = (a + b) >> 1
            range.setStart(node, mid)
            range.setEnd(node, mid + 1)
            const r = range.getClientRects()[0]
            const v = r ? this.#viewOfX(d, r.left + 1) : this.view
            if (v >= this.view) { offset = mid; b = mid - 1 } else a = mid + 1
        }
        return { node, offset }
    }

    // --- progress -----------------------------------------------------------------------------

    #sectionWeight(i) {
        const s = this.book.sections[i]
        return this.isFixed(i) ? null : Math.max(1, s.size ?? 1)
    }

    // Pages per byte measured so far, used to estimate sections not yet counted.
    #estimate() {
        let bytes = 0, pages = 0
        this.#counts.forEach((c, i) => {
            if (c != null && !this.isFixed(i)) { bytes += this.#sectionWeight(i); pages += c }
        })
        const ratio = pages && bytes ? pages / bytes : 1 / 2200
        return this.book.sections.map((s, i) => this.#counts[i] ?? (this.isFixed(i) ? 1 : Math.max(1, Math.round(this.#sectionWeight(i) * ratio))))
    }

    #sectionAtFraction(fraction) {
        const est = this.#estimate()
        const total = est.reduce((a, b) => a + b, 0)
        let target = fraction * total, acc = 0
        for (let i = 0; i < est.length; i++) {
            if (acc + est[i] > target || i === est.length - 1) {
                return { index: i, within: Math.max(0, Math.min(0.999, (target - acc) / est[i])) }
            }
            acc += est[i]
        }
        return { index: 0, within: 0 }
    }

    progress() {
        const d = this.#display
        if (!d) return null
        const est = this.#estimate()
        const total = est.reduce((a, b) => a + b, 0)
        const before = est.slice(0, d.index).reduce((a, b) => a + b, 0)
        const n = d.type === 'flow' ? d.dims.n : d.indices.length
        const first = before + (d.type === 'flow' ? this.view * n : 0) + 1
        const lastPage = d.type === 'flow' ? Math.min(before + d.pages, first + n - 1) : before + d.indices.length
        return {
            index: d.index,
            indices: d.indices ?? [d.index],
            view: this.view,
            views: d.views,
            page: first,
            pageEnd: lastPage,
            total,
            exact: this.#counts.every(c => c != null),
            fraction: total > 1 ? (first - 1) / (total - 1) : 0,
            sectionPagesLeft: d.type === 'flow' ? (d.views - 1 - this.view) : 0,
            atEnd: this.#nextIndex(d.type === 'fixed' ? Math.max(...d.indices) : d.index) == null
                && (d.type !== 'flow' || this.view >= d.views - 1),
        }
    }

    /** A location that survives re-layout and is stored with the book. */
    getLocation() {
        const d = this.#display
        if (!d) return null
        const p = this.progress()
        const loc = { index: d.index, fraction: p.fraction }
        if (d.type === 'flow') {
            loc.sectionFraction = d.views > 1 ? this.view / d.views : 0
            const pos = this.#firstVisible()
            if (pos) {
                loc.path = nodePath(d.doc.body, pos.node)
                loc.offset = pos.offset
            }
            // PDF: remember the original page number too, so the location survives a layout mode change.
            if (this.book.pdf) {
                const anchors = [...d.doc.querySelectorAll('span[id^="pdf-p"]')]
                let page = this.book.sections[d.index].pages?.[0]
                for (const a of anchors) {
                    const v = this.#viewOfRect(d, a.getClientRects())
                    if (v != null && v <= this.view) page = Number(a.id.slice(5))
                    else if (v != null && v > this.view) break
                }
                loc.pdfPage = page
            }
        } else if (this.book.pdf) {
            loc.pdfPage = this.book.sections[d.index].pdfPage
        }
        return loc
    }

    /** Size (pt) of the current section's main text before any text size setting. */
    baseTextSize() {
        const d = this.#display
        return d?.type === 'flow' ? d.doc.brBaseTextSize ?? null : null
    }

    /** View number (in the current section) where an anchor lives; used for the TOC highlight. */
    async viewOf(anchor) {
        const d = this.#display
        if (d?.type !== 'flow') return 0
        return this.#viewOfAnchor(d, anchor)
    }

    // --- relayout -----------------------------------------------------------------------------

    async relayout() {
        const d = this.#display
        const dims = this.#computeDims()
        this.#dims = dims
        this.#counts = new Array(this.book.sections.length).fill(null)
        this.#counterGen++
        if (!d) return
        if (d.type === 'flow') {
            const pos = this.#firstVisible()
            const path = pos ? nodePath(d.doc.body, pos.node) : null
            const offset = pos?.offset
            const fraction = d.views > 1 ? this.view / d.views : 0
            const token = ++this.#token
            d.iframe.classList.remove('animate')
            d.iframe.style.width = `${dims.W}px`
            d.iframe.style.height = `${dims.H}px`
            const { pages, views } = await layoutFlow(d.doc, dims, this.#settings, this.book)
            if (token !== this.#token) return
            d.iframe.style.width = `${views * dims.W}px`
            Object.assign(d, { pages, views, dims })
            this.#textNodes = null
            this.#counts[d.index] = pages
            const view = path ? this.#viewOfPath(d, path, offset) : Math.floor(fraction * views)
            this.#setView(view, false)
        } else {
            // Fixed pages are re-rendered at the new size (new dims → #show rebuilds them,
            // and the two-page grouping may change too).
            await this.#navigate({ index: d.index })
        }
        this.#scheduleCount()
    }

    // --- background page counting --------------------------------------------------------------

    #scheduleCount() {
        clearTimeout(this.#counterTimer)
        this.#counterTimer = setTimeout(() => this.#count(), 700)
    }

    async #count() {
        const gen = ++this.#counterGen
        const dims = this.#dims
        let host = this.countHost
        if (!host) {
            host = this.countHost = document.createElement('div')
            host.style.cssText = 'position:fixed;left:-200000px;top:0;visibility:hidden;pointer-events:none;overflow:hidden'
            document.body.append(host)
        }
        host.style.width = `${dims.W}px`
        host.style.height = `${dims.H}px`
        let lastEmit = performance.now()
        for (let i = 0; i < this.book.sections.length; i++) {
            if (gen !== this.#counterGen) return
            if (this.#counts[i] != null) continue
            if (this.isFixed(i)) { this.#counts[i] = 1; continue }
            await idle()
            if (gen !== this.#counterGen) return
            const section = this.book.sections[i]
            const iframe = makeIframe()
            iframe.style.cssText = `width:${dims.W}px;height:${dims.H}px;border:0`
            host.replaceChildren(iframe)
            try {
                const url = await section.load()
                await loadIframe(iframe, url)
                if (gen !== this.#counterGen) return
                const { pages } = await layoutFlow(iframe.contentDocument, dims, this.#settings, this.book)
                if (gen !== this.#counterGen) return
                this.#counts[i] = pages
            } catch (e) {
                console.warn('Could not count pages of section', i, e)
                this.#counts[i] = 1
            }
            if (performance.now() - lastEmit > 400) {
                lastEmit = performance.now()
                this.dispatchEvent(new CustomEvent('relocate', { detail: this.progress() }))
            }
        }
        host.replaceChildren()
        this.dispatchEvent(new CustomEvent('relocate', { detail: this.progress() }))
    }

    destroy() {
        this.#counterGen++
        this.#token++
        clearTimeout(this.#counterTimer)
        this.resizeObserver.disconnect()
        this.#display?.destroy()
        this.#display = null
        this.countHost?.remove()
        this.#stage.querySelectorAll('.page-layer').forEach(el => el.remove())
    }
}
