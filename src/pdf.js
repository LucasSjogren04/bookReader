// PDF → book conversion.
//
// Every page is analysed once (when the book is added) and the result is cached:
//   * text is grouped into lines, columns, paragraphs and headings so it can be reflowed as HTML;
//   * images, vector drawings (charts, diagrams), tables, maths, footnotes/citations, rotated text
//     and title pages are detected. Such pages keep their original construction and are rendered
//     as the real PDF page, because splitting them up would look wrong.
// Consecutive reflowable pages are merged into one HTML section so paragraphs continue across
// the original page breaks.

import * as pdfjs from '../vendor/pdfjs/pdf.js'
import { getCache, putCache } from './db.js'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.js', import.meta.url).href

const DOC_OPTIONS = {
    cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false,
}

const ANALYSIS_VERSION = 3
const { OPS, Util } = pdfjs

const escapeHTML = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const median = arr => {
    if (!arr.length) return 0
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
}
const percentile = (arr, p) => {
    if (!arr.length) return 0
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}

// ---------------------------------------------------------------------------------------------
// Graphics: walk the operator list keeping track of the transformation matrix, to measure how
// much of the page is covered by images and by real drawings (as opposed to thin rules).

const multiply = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
]
const applyToBox = (m, [x0, y0, x1, y1]) => {
    const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const IMAGE_OPS = new Set([
    OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObjectGroup,
    OPS.paintImageMaskXObjectGroup, OPS.paintSolidColorImageMask,
].filter(x => x != null))
const PAINT_PATH_OPS = new Set([
    OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke,
].filter(x => x != null))

const analyzeGraphics = (opList, pageW, pageH) => {
    const pageArea = pageW * pageH
    let ctm = [1, 0, 0, 1, 0, 0]
    const stack = []
    let imageArea = 0, imageCount = 0
    let pending = null
    let drawCount = 0, thinH = 0, thinV = 0
    let dBox = null
    const { fnArray, argsArray } = opList
    for (let i = 0; i < fnArray.length; i++) {
        const fn = fnArray[i], args = argsArray[i]
        if (fn === OPS.save) stack.push(ctm)
        else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
        else if (fn === OPS.transform) ctm = multiply(ctm, args)
        else if (fn === OPS.paintFormXObjectBegin) {
            stack.push(ctm)
            if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = multiply(ctm, Array.from(args[0]))
        }
        else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
        else if (IMAGE_OPS.has(fn)) {
            const [x0, y0, x1, y1] = applyToBox(ctm, [0, 0, 1, 1])
            const w = Math.min(x1, pageW) - Math.max(x0, 0), h = Math.min(y1, pageH) - Math.max(y0, 0)
            if (w > 0 && h > 0) {
                const area = w * h
                // Tiny images are usually bullets or decorations.
                if (area > pageArea * 0.002) { imageArea += area; imageCount++ }
            }
        }
        else if (fn === OPS.constructPath) {
            const minMax = args?.[2]
            pending = minMax && minMax.length >= 4 && Number.isFinite(minMax[0])
                ? applyToBox(ctm, Array.from(minMax).slice(0, 4)) : null
        }
        else if (PAINT_PATH_OPS.has(fn) || fn === OPS.shadingFill) {
            const box = fn === OPS.shadingFill ? null : pending
            pending = null
            if (!box) { if (fn === OPS.shadingFill) drawCount++; continue }
            const w = box[2] - box[0], h = box[3] - box[1]
            if (w * h > pageArea * 0.85) continue // page background
            if (h < 2.5 && w > 12) { thinH++; continue }
            if (w < 2.5 && h > 10) { thinV++; continue }
            if (w < 2.5 || h < 2.5) continue
            if (w * h < pageArea * 0.0004) continue // dots, bullets
            drawCount++
            dBox = dBox ? [Math.min(dBox[0], box[0]), Math.min(dBox[1], box[1]), Math.max(dBox[2], box[2]), Math.max(dBox[3], box[3])] : box
        }
        else if (fn === OPS.endPath) pending = null
    }
    const drawArea = dBox ? (Math.min(dBox[2], pageW) - Math.max(dBox[0], 0)) * (Math.min(dBox[3], pageH) - Math.max(dBox[1], 0)) : 0
    return {
        imageRatio: Math.min(1, imageArea / pageArea),
        imageCount,
        drawCount,
        drawRatio: Math.max(0, drawArea / pageArea),
        thinH, thinV,
    }
}

// ---------------------------------------------------------------------------------------------
// Text: chunks → rows → lines (segments separated by large gaps).

const MATH_FONT = /CMMI|CMSY|CMEX|MSAM|MSBM|Math|Symbol|MTExtra|STIX|Cambria\s?Math|rsfs|eufm/i
const BOLD_FONT = /bold|black|heavy|semibold|demi|[-,]bd\b|\+?\w*-B\b/i
const ITALIC_FONT = /italic|oblique|[-,]it\b|slanted|-I\b|CMTI|CMSL/i
const MONO_FONT = /mono|courier|consol|CMTT|menlo|code/i
const SANS_FONT = /arial|helvet|sans|calibri|verdana|segoe|gill|futura|tahoma|frutiger|myriad|univers|lato|roboto|source\s?sans/i

const fontInfo = (page, styles, fontName) => {
    let name = '', bold = false, italic = false
    try {
        if (page.commonObjs.has(fontName)) {
            const f = page.commonObjs.get(fontName)
            name = f?.name ?? ''
            bold = !!(f?.bold || f?.black)
            italic = !!f?.italic
        }
    } catch {}
    const family = styles?.[fontName]?.fontFamily ?? ''
    name = name.replace(/^[A-Z]{6}\+/, '')
    return {
        name,
        bold: bold || BOLD_FONT.test(name),
        italic: italic || ITALIC_FONT.test(name),
        mono: MONO_FONT.test(name) || family === 'monospace',
        math: MATH_FONT.test(name),
        sans: SANS_FONT.test(name) || (!name && family === 'sans-serif'),
    }
}

const extractText = (page, textContent, viewport) => {
    const fonts = new Map()
    const chunks = []
    let rotatedChars = 0
    for (const item of textContent.items) {
        if (!item.str || !item.str.trim()) continue
        const tx = Util.transform(viewport.transform, item.transform)
        const size = Math.hypot(tx[2], tx[3])
        if (size < 1) continue
        if (Math.abs(tx[1]) > 0.02 * Math.abs(tx[0]) || tx[0] <= 0) {
            rotatedChars += item.str.length
            continue
        }
        if (!fonts.has(item.fontName)) fonts.set(item.fontName, fontInfo(page, textContent.styles, item.fontName))
        const f = fonts.get(item.fontName)
        const x0 = tx[4], base = tx[5]
        const width = item.width * (viewport.scale ?? 1)
        chunks.push({
            s: item.str, x0, x1: x0 + Math.max(width, size * 0.2 * item.str.length),
            base, top: base - size * 0.8, bottom: base + size * 0.2, size,
            bold: f.bold, italic: f.italic, mono: f.mono, math: f.math, sans: f.sans,
        })
    }
    return { chunks, rotatedChars }
}

const groupRows = chunks => {
    const sorted = [...chunks].sort((a, b) => a.top - b.top || a.x0 - b.x0)
    const rows = []
    for (const c of sorted) {
        let best = null, bestOverlap = 0
        for (let i = rows.length - 1; i >= 0 && i >= rows.length - 4; i--) {
            const r = rows[i]
            const overlap = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top)
            const ratio = overlap / Math.min(r.bottom - r.top, c.bottom - c.top)
            if (ratio > 0.5 && ratio > bestOverlap) { best = r; bestOverlap = ratio }
        }
        if (best) {
            best.chunks.push(c)
            if (c.size > best.size) Object.assign(best, { size: c.size, top: c.top, bottom: c.bottom, base: c.base })
        } else rows.push({ chunks: [c], size: c.size, top: c.top, bottom: c.bottom, base: c.base })
    }
    return rows
}

const SPACE_RE = /\s$/
const rowToLines = row => {
    const chunks = row.chunks.sort((a, b) => a.x0 - b.x0)
    const lines = []
    let cur = null
    for (const c of chunks) {
        const gap = cur ? c.x0 - cur.x1 : 0
        if (cur && gap > 1.5 * Math.max(row.size, c.size)) { lines.push(cur); cur = null }
        if (!cur) cur = { chunks: [], x0: c.x0, x1: c.x1, top: row.top, bottom: row.bottom, base: row.base, size: 0 }
        // Skip duplicated glyph runs (fake bold drawn twice at nearly the same position).
        const last = cur.chunks.at(-1)
        if (last && last.s === c.s && Math.abs(last.x0 - c.x0) < c.size * 0.3) continue
        cur.chunks.push(c)
        cur.x1 = Math.max(cur.x1, c.x1)
        cur.size = Math.max(cur.size, c.size)
    }
    if (cur) lines.push(cur)
    for (const line of lines) {
        // The line's nominal size is that of most of its characters, so a drop cap or a
        // superscript doesn't change it.
        const bySize = new Map()
        for (const c of line.chunks) {
            const k = Math.round(c.size * 2) / 2
            bySize.set(k, (bySize.get(k) ?? 0) + c.s.length)
        }
        line.size = [...bySize].sort((a, b) => b[1] - a[1])[0][0]
        const main = line.chunks.filter(c => Math.abs(c.size - line.size) < 0.6)
        line.base = median(main.map(c => c.base)) || line.base
        line.text = line.chunks.map(c => c.s).join(' ')
        line.chars = line.chunks.reduce((n, c) => n + c.s.replace(/\s/g, '').length, 0)
        line.bold = main.every(c => c.bold)
        line.italic = main.every(c => c.italic)
        line.mono = main.every(c => c.mono)
        line.sans = main.filter(c => c.sans).length > main.length / 2
    }
    return lines
}

const lineHTML = line => {
    let html = '', prev = null
    for (const c of line.chunks) {
        let s = escapeHTML(c.s)
        if (prev) {
            const gap = c.x0 - prev.x1
            if (gap > c.size * 0.12 && !SPACE_RE.test(prev.s) && !/^\s/.test(c.s)) html += ' '
        }
        const isSup = c.size < line.size * 0.82 && c.base < line.base - line.size * 0.15
        const isSub = c.size < line.size * 0.82 && c.base > line.base + line.size * 0.1
        if (c.italic && !line.italic) s = `<i>${s}</i>`
        if (c.bold && !line.bold) s = `<b>${s}</b>`
        if (isSup) s = `<sup>${s}</sup>`
        else if (isSub) s = `<sub>${s}</sub>`
        html += s
        prev = c
    }
    return html.replace(/<\/i><i>|<\/b><b>/g, '')
}

// ---------------------------------------------------------------------------------------------
// Page analysis (first pass, no document-level knowledge yet).

const analyzePage = async (page) => {
    const viewport = page.getViewport({ scale: 1 })
    const [opList, textContent] = await Promise.all([
        page.getOperatorList(),
        page.getTextContent(),
    ])
    const graphics = analyzeGraphics(opList, page.view[2] - page.view[0], page.view[3] - page.view[1])
    const { chunks, rotatedChars } = extractText(page, textContent, viewport)
    const rows = groupRows(chunks)
    const lines = rows.flatMap(rowToLines)
    const tableRows = rows.filter(r => rowToLines(r).length >= 3).length
    const shortChunks = chunks.filter(c => c.s.trim().length <= 2).length
    const mathChars = chunks.filter(c => c.math).reduce((n, c) => n + c.s.length, 0)
    const totalChars = chunks.reduce((n, c) => n + c.s.length, 0)
    return {
        w: viewport.width, h: viewport.height,
        graphics, rotatedChars, tableRows,
        shortChunkRatio: chunks.length ? shortChunks / chunks.length : 0,
        chunkCount: chunks.length,
        mathRatio: totalChars ? mathChars / totalChars : 0,
        lines: lines.map(l => ({
            x0: l.x0, x1: l.x1, top: l.top, bottom: l.bottom, base: l.base, size: l.size,
            text: l.text, chars: l.chars, bold: l.bold, italic: l.italic, mono: l.mono, sans: l.sans,
            html: lineHTML(l),
        })),
    }
}

// ---------------------------------------------------------------------------------------------
// Document-level pass: running headers/footers, body size, classification, paragraphs.

const normalizeRunning = t => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
const PAGE_NUMBER_RE = /^[\s\-–—(\[]*(page\s*|p\.\s*)?([0-9]+|[ivxlcdm]+)(\s*(of|\/)\s*[0-9]+)?[\s\-–—)\]]*$/i

const markRunningHeaders = pages => {
    const counts = new Map()
    const candidates = pages.map(p => {
        const sorted = [...p.lines].sort((a, b) => a.top - b.top)
        const result = []
        for (const l of [...sorted.slice(0, 2), ...sorted.slice(-2)]) {
            if (l.top < p.h * 0.1 || l.bottom > p.h * 0.9) {
                if (l.chars < 120) result.push(l)
            }
        }
        for (const l of new Set(result)) {
            const k = normalizeRunning(l.text)
            counts.set(k, (counts.get(k) ?? 0) + 1)
        }
        return [...new Set(result)]
    })
    const threshold = Math.max(3, pages.length * 0.2)
    candidates.forEach((lines, i) => {
        for (const l of lines) {
            if (PAGE_NUMBER_RE.test(l.text) || counts.get(normalizeRunning(l.text)) >= threshold) l.running = true
        }
        pages[i].lines = pages[i].lines.filter(l => !l.running)
    })
}

const docStats = pages => {
    const sizes = new Map()
    let indented = 0, paraStarts = 0
    const families = { serif: 0, sans: 0 }
    for (const p of pages) for (const l of p.lines) {
        const k = Math.round(l.size * 2) / 2
        sizes.set(k, (sizes.get(k) ?? 0) + l.chars)
        families[l.sans ? 'sans' : 'serif'] += l.chars
    }
    const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10
    return { bodySize, indented, paraStarts, sans: families.sans > families.serif }
}

const classify = (p, stats) => {
    const body = stats.bodySize
    const reasons = []
    const g = p.graphics
    const chars = p.lines.reduce((n, l) => n + l.chars, 0)
    if (g.imageRatio > 0.04) reasons.push('figure')
    if (g.drawCount >= 3 && g.drawRatio > 0.06) reasons.push('drawing')
    if (g.thinH >= 3 && g.thinV >= 3) reasons.push('table')
    if (p.tableRows >= 3) reasons.push('table')
    if (p.rotatedChars > 20 && p.rotatedChars > chars * 0.08) reasons.push('rotated')
    if (p.mathRatio > 0.04 || (p.chunkCount > 40 && p.shortChunkRatio > 0.45)) reasons.push('math')
    const small = p.lines.filter(l => l.size < body * 0.82 && l.chars > 6)
    const smallChars = small.reduce((n, l) => n + l.chars, 0)
    if (small.length >= 2 && smallChars > chars * 0.12) reasons.push('notes')
    const maxSize = Math.max(0, ...p.lines.map(l => l.size))
    if (chars > 0 && chars < 600 && maxSize >= body * 1.6) reasons.push('title')
    // Lots of empty space with little text and some graphics → a designed page.
    if (chars < 40 && (g.imageCount || g.drawCount)) reasons.push('figure')
    // Text spread in more than two columns behaves like a table.
    if (p.columns > 2) reasons.push('columns')
    if (!chars && !reasons.length) return { mode: 'empty', reasons }
    return { mode: reasons.length ? 'fixed' : 'flow', reasons: [...new Set(reasons)] }
}

// Reading order: detect a two-column layout by looking for an empty vertical gutter.
const orderLines = p => {
    const lines = [...p.lines].sort((a, b) => a.top - b.top || a.x0 - b.x0)
    p.columns = 1
    if (lines.length < 8) return [lines]
    const xs = lines.map(l => l.x0), xe = lines.map(l => l.x1)
    const left = Math.min(...xs), right = Math.max(...xe), width = right - left
    if (width <= 0) return [lines]
    const BINS = 120
    const cover = new Array(BINS).fill(0)
    const narrow = lines.filter(l => l.x1 - l.x0 < width * 0.62)
    for (const l of narrow) {
        const a = Math.floor((l.x0 - left) / width * BINS), b = Math.ceil((l.x1 - left) / width * BINS)
        for (let i = Math.max(0, a); i < Math.min(BINS, b); i++) cover[i]++
    }
    // Count separate column runs (for >2 columns detection) and find the central gutter.
    let runs = 0, inRun = false
    for (const c of cover) { if (c > 1 && !inRun) { runs++; inRun = true } else if (c <= 1) inRun = false }
    let best = null
    for (let i = Math.floor(BINS * 0.3); i < Math.ceil(BINS * 0.7); i++) {
        if (cover[i] !== 0) continue
        let j = i
        while (j < BINS && cover[j] === 0) j++
        if (!best || j - i > best[1] - best[0]) best = [i, j]
        i = j
    }
    if (!best || narrow.length < lines.length * 0.5) return [lines]
    const gx = left + (best[0] + best[1]) / 2 / BINS * width
    const L = lines.filter(l => l.x1 <= gx), R = lines.filter(l => l.x0 >= gx)
    if (L.length < 4 || R.length < 4) return [lines]
    p.columns = Math.max(2, runs)
    const full = lines.filter(l => l.x0 < gx && l.x1 > gx)
    const groups = []
    let lo = -Infinity
    for (const f of [...full, null]) {
        const hi = f ? f.top : Infinity
        const l = L.filter(x => x.top >= lo && x.top < hi), r = R.filter(x => x.top >= lo && x.top < hi)
        if (l.length) groups.push(l)
        if (r.length) groups.push(r)
        if (f) groups.push([f])
        lo = hi
    }
    return groups
}

const END_PUNCT = /[.!?:;…"”’»)\]]$/
const STARTS_LOWER = /^[\p{Ll}\d(“"'‘,;]/u

const buildBlocks = (p, stats) => {
    const body = stats.bodySize
    const groups = orderLines(p)
    const blocks = []
    let para = null
    const baseGaps = []
    for (const g of groups) for (let i = 1; i < g.length; i++) {
        const d = g[i].base - g[i - 1].base
        if (d > 0 && Math.abs(g[i].size - g[i - 1].size) < 0.5) baseGaps.push(d / g[i].size)
    }
    const typicalGap = median(baseGaps) || 1.25
    const tagFor = l => {
        const r = l.size / body
        if (r >= 1.75) return 'h1'
        if (r >= 1.4) return 'h2'
        if (r >= 1.18) return 'h3'
        return 'p'
    }
    const close = () => { if (para) blocks.push(para); para = null }
    for (const g of groups) {
        const colLeft = percentile(g.map(l => l.x0), 0.15)
        const colRight = percentile(g.map(l => l.x1), 0.85)
        const colCenter = (colLeft + colRight) / 2
        let prev = null
        for (const l of g) {
            const tag = tagFor(l)
            const indent = l.x0 - colLeft
            const centered = Math.abs((l.x0 + l.x1) / 2 - colCenter) < l.size * 1.5
                && indent > l.size * 2 && colRight - l.x1 > l.size * 2
            let newPara = !para || !prev
            if (!newPara) {
                const gap = (l.base - prev.base) / l.size
                const prevShort = prev.x1 < colRight - l.size * 2.5
                if (tag !== para.tag) newPara = true
                else if (Math.abs(l.size - prev.size) > l.size * 0.15) newPara = true
                else if (gap > typicalGap * 1.4 || gap < 0) newPara = true
                else if (indent > l.size * 0.9 && !(prev.x0 - colLeft > l.size * 0.9) && !centered) newPara = true
                else if (prevShort && END_PUNCT.test(prev.text.trim()) && !para.centered) newPara = true
                else if (centered !== !!para.centered) newPara = true
                else if (l.bold !== prev.bold && (l.bold ? l.chars < 100 : prev.chars < 100)) newPara = true
            } else if (para && !prev) {
                // First line of a new column group: continue the paragraph if it reads on.
                const last = para.lastLine
                newPara = !(tag === 'p' && para.tag === 'p' && !END_PUNCT.test(last.text.trim())
                    && STARTS_LOWER.test(l.text.trim()))
            }
            if (newPara) {
                close()
                para = { tag, html: '', centered, bold: l.bold, indented: indent > l.size * 0.9, lines: 0, firstLine: l }
                para.html = l.html
            } else {
                const prevText = para.lastLine.text.trimEnd()
                if (para.centered) para.html += '<br>' + l.html
                else if (/[-­]$/.test(prevText) && STARTS_LOWER.test(l.text.trim()))
                    para.html = para.html.replace(/[-­](<\/[a-z]+>)*\s*$/, '$1') + l.html
                else para.html += ' ' + l.html
            }
            para.lines++
            para.lastLine = l
            prev = l
        }
    }
    close()
    // Short bold paragraphs on their own read as headings.
    for (const b of blocks) {
        if (b.tag === 'p' && b.bold && b.lines <= 2 && b.html.length < 160 && !END_PUNCT.test(b.lastLine.text.trim())) b.tag = 'h4'
    }
    const first = blocks[0], last = blocks.at(-1)
    return {
        blocks: blocks.map(b => ({ tag: b.tag, html: b.html, c: b.centered ? 1 : 0, i: b.indented ? 1 : 0 })),
        startsCont: !!first && first.tag === 'p' && !first.centered && !first.indented && STARTS_LOWER.test(first.firstLine.text.trim()),
        endsOpen: !!last && last.tag === 'p' && !last.centered && !END_PUNCT.test(last.lastLine.text.trim()),
        indentedParas: blocks.filter(b => b.tag === 'p' && b.indented).length,
        paras: blocks.filter(b => b.tag === 'p').length,
    }
}

const analyzeDocument = async (pdf, onProgress) => {
    const pages = []
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i)
        try {
            pages.push(await analyzePage(page))
        } catch (e) {
            console.warn('PDF page analysis failed', i, e)
            pages.push({ w: 612, h: 792, failed: true, lines: [], graphics: { imageRatio: 0, imageCount: 0, drawCount: 0, drawRatio: 0, thinH: 0, thinV: 0 }, rotatedChars: 0, tableRows: 0, shortChunkRatio: 0, chunkCount: 0, mathRatio: 0 })
        }
        page.cleanup()
        onProgress?.(i, pdf.numPages)
        if (i % 4 === 0) await new Promise(r => setTimeout(r))
    }
    markRunningHeaders(pages)
    const stats = docStats(pages)
    let indented = 0, paras = 0
    const result = pages.map(p => {
        const built = buildBlocks(p, stats)
        indented += built.indentedParas
        paras += built.paras
        const { mode, reasons } = p.failed ? { mode: 'fixed', reasons: ['error'] } : classify(p, stats)
        return {
            w: p.w, h: p.h, mode, reasons,
            imageRatio: p.graphics.imageRatio,
            blocks: built.blocks, startsCont: built.startsCont, endsOpen: built.endsOpen,
        }
    })
    // If most pages need their original layout (e.g. a paper or a magazine), keep all of them:
    // switching back and forth between reflowed text and page images would be jarring.
    const nonEmpty = result.filter(p => p.mode !== 'empty')
    const fixedShare = nonEmpty.filter(p => p.mode === 'fixed').length / (nonEmpty.length || 1)
    return {
        version: ANALYSIS_VERSION,
        pages: result,
        bodySize: stats.bodySize,
        sans: stats.sans,
        indentParas: paras ? indented / paras > 0.3 : true,
        mostlyFixed: fixedShare > 0.5,
    }
}

// ---------------------------------------------------------------------------------------------
// HTML generation for runs of reflowable pages.

const flowCSS = a => `
body { font-family: ${a.sans ? '"Segoe UI", Helvetica, Arial, sans-serif' : 'Georgia, "Times New Roman", serif'}; line-height: 1.5; }
p { margin: ${a.indentParas ? '0' : '0 0 .7em'}; text-indent: ${a.indentParas ? '1.4em' : '0'}; text-align: justify; }
p.c { text-align: center; text-indent: 0; margin: .6em 0; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.1em 0 .6em; text-indent: 0; break-after: avoid; }
h1 { font-size: 1.9em; } h2 { font-size: 1.5em; } h3 { font-size: 1.2em; } h4 { font-size: 1em; }
h1 + p, h2 + p, h3 + p, h4 + p, p.c + p { text-indent: 0; }
sup, sub { font-size: .7em; line-height: 0; }
`

const flowHTML = (pages, analysis, lang) => {
    const out = []
    let last = null
    for (const { n, data } of pages) {
        const anchor = `<span id="pdf-p${n}"></span>`
        const blocks = data.blocks
        if (!blocks.length) { out.push(anchor); last = null; continue }
        blocks.forEach((b, i) => {
            const cls = b.c ? ' class="c"' : ''
            const a = i === 0 ? anchor : ''
            if (i === 0 && last && last.tag === 'p' && last.open && data.startsCont && b.tag === 'p') {
                const prev = out[last.index]
                const hyphen = /[-­](<\/[a-z]+>)*\s*<\/p>$/.test(prev)
                out[last.index] = prev.replace(/([-­])?((<\/[a-z]+>)*)\s*<\/p>$/, (m, h, tags) =>
                    (hyphen ? tags : (h ?? '') + tags + ' ')) + a + b.html + '</p>'
            } else {
                out.push(`<${b.tag}${cls}>${a}${b.html}</${b.tag}>`)
            }
            last = { tag: b.tag, index: out.length - 1, open: false }
        })
        if (last) last.open = data.endsOpen
    }
    return `<!DOCTYPE html><html lang="${lang ?? ''}"><head><meta charset="utf-8"><style>${flowCSS(analysis)}</style></head><body>${out.join('\n')}</body></html>`
}

// ---------------------------------------------------------------------------------------------
// Book object

const outlineToTOC = async (pdf, items) => {
    const resolveDest = async dest => {
        try {
            const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
            if (!d?.[0]) return null
            return typeof d[0] === 'number' ? d[0] + 1 : (await pdf.getPageIndex(d[0])) + 1
        } catch { return null }
    }
    const result = []
    for (const item of items ?? []) {
        const page = await resolveDest(item.dest)
        const subitems = await outlineToTOC(pdf, item.items)
        result.push({ label: item.title, href: page ? `page:${page}` : null, subitems: subitems.length ? subitems : undefined })
    }
    return result
}

export const loadPDF = async file => {
    const data = new Uint8Array(await file.arrayBuffer())
    return pdfjs.getDocument({ ...DOC_OPTIONS, data }).promise
}

const TEXT_LAYER_CSS_ID = 'pdf-text-layer-css'
const ensureTextLayerCSS = () => {
    if (document.getElementById(TEXT_LAYER_CSS_ID)) return
    const style = document.createElement('style')
    style.id = TEXT_LAYER_CSS_ID
    style.textContent = `.textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;z-index:2}
.textLayer span,.textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}
.textLayer ::selection{background:rgb(0 90 255 / .3)}
.textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:-1;cursor:default;user-select:none}`
    document.head.append(style)
}

export const makePDFBook = async (file, { bookId, onProgress, pdfMode = 'smart' } = {}) => {
    const pdf = await loadPDF(file)
    let analysis = bookId ? await getCache(bookId) : null
    if (analysis?.version !== ANALYSIS_VERSION) {
        analysis = await analyzeDocument(pdf, onProgress)
        if (bookId) await putCache(bookId, analysis)
    }
    const info = (await pdf.getMetadata().catch(() => null))?.info ?? {}
    const toc = await outlineToTOC(pdf, await pdf.getOutline().catch(() => null))
    const urls = new Set()
    const canvasCache = new Map()

    const renderPage = async (n, cssW, cssH) => {
        const key = `${n}:${Math.round(cssW)}x${Math.round(cssH)}`
        if (canvasCache.has(key)) return canvasCache.get(key)
        const promise = (async () => {
            const page = await pdf.getPage(n)
            const vp1 = page.getViewport({ scale: 1 })
            const scale = Math.min(cssW / vp1.width, cssH / vp1.height)
            const dpr = Math.min(window.devicePixelRatio || 1, 3)
            const viewport = page.getViewport({ scale: scale * dpr })
            const canvas = document.createElement('canvas')
            canvas.width = Math.floor(viewport.width)
            canvas.height = Math.floor(viewport.height)
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
            const textContent = await page.getTextContent()
            return { canvas, width: vp1.width * scale, height: vp1.height * scale, scale, page, textContent }
        })()
        canvasCache.set(key, promise)
        promise.catch(() => canvasCache.delete(key))
        while (canvasCache.size > 10) canvasCache.delete(canvasCache.keys().next().value)
        return promise
    }

    const fixedSection = n => {
        const data = analysis.pages[n - 1]
        return {
            id: `page-${n}`,
            pages: [n],
            size: 2000,
            pdfPage: n,
            width: data.w, height: data.h,
            imageRatio: data.imageRatio,
            reasons: data.reasons,
            prefetch: (w, h) => renderPage(n, w, h).catch(() => {}),
            render: async (w, h) => {
                const r = await renderPage(n, w, h)
                const el = document.createElement('div')
                el.className = 'fixed-page'
                el.style.width = `${r.width}px`
                el.style.height = `${r.height}px`
                const canvas = r.canvas.cloneNode()
                canvas.getContext('2d').drawImage(r.canvas, 0, 0)
                canvas.style.width = `${r.width}px`
                canvas.style.height = `${r.height}px`
                el.append(canvas)
                // Invisible text layer so text on original pages can still be selected and copied.
                try {
                    ensureTextLayerCSS()
                    const layer = document.createElement('div')
                    layer.className = 'textLayer'
                    layer.style.setProperty('--scale-factor', r.scale)
                    el.append(layer)
                    const tl = new pdfjs.TextLayer({
                        textContentSource: r.textContent, container: layer,
                        viewport: r.page.getViewport({ scale: r.scale }),
                    })
                    tl.render().catch(() => {})
                } catch {}
                return el
            },
        }
    }

    const flowSection = pages => {
        let url
        const html = () => flowHTML(pages.map(n => ({ n, data: analysis.pages[n - 1] })), analysis, info.Language)
        return {
            id: `flow-${pages[0]}`,
            pages,
            size: pages.reduce((n, p) => n + analysis.pages[p - 1].blocks.reduce((m, b) => m + b.html.length, 0), 0) || 1,
            load: () => {
                if (!url) { url = URL.createObjectURL(new Blob([html()], { type: 'text/html' })); urls.add(url) }
                return url
            },
        }
    }

    const buildSections = mode => {
        const sections = []
        let run = []
        const flush = () => { if (run.length) sections.push(flowSection(run)); run = [] }
        const allFixed = mode === 'original' || (mode === 'smart' && analysis.mostlyFixed)
        analysis.pages.forEach((p, i) => {
            const n = i + 1
            // In "reflow all" mode, pages without any text (scans, full-page pictures) stay as images.
            const fixed = allFixed
                || (mode === 'smart' && p.mode === 'fixed')
                || (mode === 'reflow' && p.mode === 'fixed' && !p.blocks.length)
            if (fixed) { flush(); sections.push(fixedSection(n)) }
            else run.push(n)
        })
        flush()
        return sections
    }

    const book = {
        metadata: {
            title: info.Title?.trim() || '',
            author: info.Author?.trim() || '',
            language: info.Language,
        },
        toc,
        pdf,
        analysis,
        pageCount: pdf.numPages,
        pdfMode,
        sections: buildSections(pdfMode),
        setMode(mode) {
            this.pdfMode = mode
            this.sections = buildSections(mode)
        },
        sectionOfPage(n) {
            const i = this.sections.findIndex(s => s.pages.includes(n))
            return i < 0 ? 0 : i
        },
        resolveHref(href) {
            const m = href?.match(/^page:(\d+)/)
            if (!m) return null
            const n = Number(m[1])
            const index = this.sectionOfPage(n)
            const s = this.sections[index]
            return { index, anchor: s.render ? null : doc => doc.getElementById(`pdf-p${n}`) }
        },
        isExternal: href => /^\w+:/.test(href) && !/^(blob|page):/.test(href),
        async getCover() {
            const page = await pdf.getPage(1)
            const vp1 = page.getViewport({ scale: 1 })
            const viewport = page.getViewport({ scale: 400 / vp1.width })
            const canvas = document.createElement('canvas')
            canvas.width = viewport.width
            canvas.height = viewport.height
            const ctx = canvas.getContext('2d')
            ctx.fillStyle = '#fff'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            await page.render({ canvasContext: ctx, viewport }).promise
            return new Promise(r => canvas.toBlob(r, 'image/webp', 0.85))
        },
        destroy() {
            for (const u of urls) URL.revokeObjectURL(u)
            canvasCache.clear()
            pdf.destroy()
        },
    }
    return book
}
