// Reader preferences, kept per browser profile.

const KEY = 'shelf-settings'

export const defaults = Object.freeze({
    theme: 'light',          // light | sepia | dark | black
    fontFamily: 'original',  // original | serif | sans | mono | custom
    customFont: '',
    textSize: 'original',    // 'original' or a size in points (like Google Docs), for the body text
    zoom: 100,               // % that scales everything (text, images, layout)
    lineHeight: 0,           // 0 = book's original
    align: 'original',       // original | justify | left
    marginSide: 5,           // % of the page width, on each side
    marginV: 36,
    spread: 'auto',          // auto | single | double
    pdfMode: 'smart',        // smart | original | reflow
    invertFixed: 'auto',     // auto | always | never (only used in dark themes)
    hyphenate: true,
    animate: true,
})

const listeners = new Set()

const load = () => {
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
    } catch {
        return { ...defaults }
    }
}

export const settings = load()

export const setSetting = (key, value) => {
    if (settings[key] === value) return
    settings[key] = value
    try { localStorage.setItem(KEY, JSON.stringify(settings)) } catch {}
    for (const fn of listeners) fn(key, value)
}

export const resetSettings = () => {
    for (const [key, value] of Object.entries(defaults)) setSetting(key, value)
}

export const onSettingChange = fn => {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

export const THEMES = {
    light: { bg: '#ffffff', fg: '#1d1d1f', link: '#2f54c9', dark: false },
    sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8a4f1c', dark: false },
    dark: { bg: '#212226', fg: '#d6d6d9', link: '#8ea8ff', dark: true },
    black: { bg: '#000000', fg: '#c9c9cc', link: '#8ea8ff', dark: true },
}

export const fontStack = s => {
    switch (s.fontFamily) {
        case 'serif': return 'Charter, "Iowan Old Style", Georgia, "Palatino Linotype", Cambria, serif'
        case 'sans': return 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
        case 'mono': return 'ui-monospace, Consolas, "SF Mono", Menlo, monospace'
        case 'custom': return s.customFont?.trim()
            ? `"${s.customFont.trim().replace(/"/g, '')}", Georgia, serif` : null
        default: return null
    }
}
