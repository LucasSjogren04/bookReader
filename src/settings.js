// Reader preferences, kept per browser profile.

const KEY = 'shelf-settings'

export const defaults = Object.freeze({
    theme: 'light',          // light | sepia | dark | black
    fontFamily: 'original',  // original | serif | sans | mono | custom
    customFont: '',
    textSize: 'original',    // 'original' or a size in points (like Google Docs), for the body text
    lineHeight: 0,           // 0 = book's original
    align: 'original',       // original | justify | left
    marginSize: 1,           // side margins: 0 none, 1 narrow, 2 medium, 3 wide (see MARGIN_SIZES)
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

// Side margin per position of the slider, as a share of each page's width so the same choice
// looks the same on 1080p, 1440p and 4K screens.
export const MARGIN_SIZES = [
    { name: 'None', share: 0.015 },
    { name: 'Narrow', share: 0.05 },
    { name: 'Medium', share: 0.12 },
    { name: 'Wide', share: 0.25 },
]

export const THEMES = {
    light: { bg: '#ffffff', fg: '#202122', link: '#3366cc', dark: false },
    sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8a4f1c', dark: false },
    dark: { bg: '#101418', fg: '#eaecf0', link: '#88a3e8', dark: true },
    black: { bg: '#000000', fg: '#eaecf0', link: '#88a3e8', dark: true },
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
