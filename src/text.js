// Plain text, Markdown and standalone HTML files → book object with HTML sections.

const escapeHTML = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const decode = async file => {
    const buf = await file.arrayBuffer()
    const head = new Uint8Array(buf.slice(0, 4))
    if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf)
    if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(buf)
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
        return new TextDecoder('windows-1252').decode(buf)
    }
}

const page = (title, body, lang = '') => `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${escapeHTML(title)}</title>
<style>
body { font-family: Georgia, "Palatino Linotype", serif; line-height: 1.55; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
h1, h2, h3 { text-align: center; text-indent: 0; margin: 1.2em 0 .8em; line-height: 1.25; }
h1 + p, h2 + p, h3 + p, hr + p { text-indent: 0; }
hr { border: 0; text-align: center; margin: 1em 0; }
hr::after { content: "* * *"; }
pre { white-space: pre-wrap; font-size: .9em; }
blockquote { margin: .6em 1.5em; }
img { max-width: 100%; }
</style></head><body>${body}</body></html>`

const CHAPTER_RE = /^\s*((chapter|part|book|prologue|epilogue|introduction|preface|kapitel|chapitre|capítulo|capitolo|hoofdstuk|глава|часть)\b.{0,80}|[IVXLC]{1,7}\.?|\d{1,3}\.?)\s*$/i

const textToSections = (text, name) => {
    text = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    const hasBlankLines = /\n\s*\n/.test(text)
    const blocks = hasBlankLines ? text.split(/\n\s*\n/) : text.split('\n')
    const chapters = [{ title: null, html: [] }]
    for (const raw of blocks) {
        const block = raw.replace(/^\n+|\s+$/g, '')
        if (!block.trim()) continue
        const oneLine = !block.includes('\n')
        if (oneLine && CHAPTER_RE.test(block)) {
            chapters.push({ title: block.trim(), html: [`<h2>${escapeHTML(block.trim())}</h2>`] })
            continue
        }
        if (/^\s*([*\-_=~#]\s*){3,}$/.test(block)) {
            chapters.at(-1).html.push('<hr>')
            continue
        }
        // Keep line structure for verse/code-like blocks, join soft-wrapped prose.
        const lines = block.split('\n')
        const shortLines = lines.length > 1 && lines.every(l => l.length < 60)
        const indented = lines.every(l => /^\s{2,}/.test(l))
        if (indented && lines.length > 1) chapters.at(-1).html.push(`<pre>${escapeHTML(block)}</pre>`)
        else if (shortLines) chapters.at(-1).html.push(`<p>${lines.map(l => escapeHTML(l.trim())).join('<br>')}</p>`)
        else chapters.at(-1).html.push(`<p>${escapeHTML(lines.map(l => l.trim()).join(' '))}</p>`)
    }
    if (!chapters[0].html.length) chapters.shift()
    // Merge tiny chapters (false positives like a lone "1.") into the previous one.
    const merged = []
    for (const c of chapters) {
        const size = c.html.join('').length
        if (merged.length && size < 200 && !c.title) merged.at(-1).html.push(...c.html)
        else merged.push(c)
    }
    return merged.map((c, i) => ({ title: c.title ?? (i ? `Part ${i + 1}` : name), html: c.html.join('\n') }))
}

// Minimal Markdown: headings, emphasis, code, lists, quotes, links, images, rules.
const inlineMD = s => escapeHTML(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '<strong>$1$2</strong>')
    .replace(/\*([^*]+)\*|\b_([^_]+)_\b/g, '<em>$1$2</em>')

const markdownToSections = (text, name) => {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    const sections = [{ title: name, html: [] }]
    let para = [], list = null, code = null
    const flush = () => {
        if (para.length) sections.at(-1).html.push(`<p>${inlineMD(para.join(' '))}</p>`)
        para = []
        if (list) sections.at(-1).html.push(`<${list.tag}>${list.items.map(i => `<li>${inlineMD(i)}</li>`).join('')}</${list.tag}>`)
        list = null
    }
    for (const line of lines) {
        if (code) {
            if (/^```/.test(line)) { sections.at(-1).html.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`); code = null }
            else code.push(line)
            continue
        }
        let m
        if (/^```/.test(line)) { flush(); code = []; continue }
        if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
            flush()
            const level = m[1].length
            if (level <= 2 && sections.at(-1).html.length) sections.push({ title: m[2], html: [] })
            sections.at(-1).html.push(`<h${level}>${inlineMD(m[2])}</h${level}>`)
            continue
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); sections.at(-1).html.push('<hr>'); continue }
        if ((m = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/))) {
            const tag = /\d/.test(m[1]) ? 'ol' : 'ul'
            if (para.length) flush()
            if (list && list.tag !== tag) flush()
            list ??= { tag, items: [] }
            list.items.push(m[2])
            continue
        }
        if ((m = line.match(/^>\s?(.*)$/))) { flush(); sections.at(-1).html.push(`<blockquote><p>${inlineMD(m[1])}</p></blockquote>`); continue }
        if (!line.trim()) { flush(); continue }
        if (list) list.items[list.items.length - 1] += ' ' + line.trim()
        else para.push(line.trim())
    }
    flush()
    return sections.filter(s => s.html.length).map(s => ({ title: s.title, html: s.html.join('\n') }))
}

export const makeTextBook = async (file, format) => {
    const name = file.name.replace(/\.[^.]+$/, '')
    const text = await decode(file)
    let sections, title = name, author = ''
    if (format === 'html') {
        const doc = new DOMParser().parseFromString(text, 'text/html')
        doc.querySelectorAll('script, iframe, object, embed').forEach(el => el.remove())
        title = doc.title || name
        author = doc.querySelector('meta[name="author"]')?.content ?? ''
        sections = [{ title, html: null, doc: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML }]
    } else if (format === 'md') {
        sections = markdownToSections(text, name)
    } else {
        sections = textToSections(text, name)
    }
    const urls = []
    const book = {
        metadata: { title, author },
        sections: sections.map((s, i) => {
            let url
            return {
                id: i,
                size: (s.doc ?? s.html).length,
                load: () => url ??= (urls[i] = URL.createObjectURL(new Blob([s.doc ?? page(s.title, s.html)], { type: 'text/html' }))),
            }
        }),
        toc: sections.length > 1 ? sections.map((s, i) => ({ label: s.title, href: `#s${i}` })) : [],
        resolveHref: href => {
            const m = href.match(/^#s(\d+)$/)
            return m ? { index: Number(m[1]) } : null
        },
        isExternal: href => /^\w+:/.test(href) && !href.startsWith('blob:'),
        getCover: () => null,
        destroy: () => urls.forEach(u => u && URL.revokeObjectURL(u)),
    }
    return book
}
