// Service worker for the web-app version: lets Shelf be installed and work offline.
// Same-origin files are served from the cache and refreshed in the background
// (stale-while-revalidate), so a new deploy is picked up on the next visit.

const CACHE = 'shelf-v2'
const SHELL = [
    './', 'reader.html', 'app.webmanifest',
    'src/style.css', 'src/app.js', 'src/db.js', 'src/settings.js', 'src/formats.js',
    'src/paginator.js', 'src/pdf.js', 'src/text.js',
    'vendor/foliate/epub.js', 'vendor/foliate/epubcfi.js', 'vendor/foliate/mobi.js',
    'vendor/foliate/fb2.js', 'vendor/foliate/comic-book.js',
    'vendor/foliate/vendor/zip.js', 'vendor/foliate/vendor/fflate.js',
    'vendor/pdfjs/pdf.js', 'vendor/pdfjs/pdf.worker.js',
    'icons/icon32.png', 'icons/icon192.png', 'icons/icon512.png',
]

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
        await self.clients.claim()
    })())
})

self.addEventListener('fetch', e => {
    const { request } = e
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.origin !== location.origin) return
    e.respondWith((async () => {
        const cache = await caches.open(CACHE)
        const cached = await cache.match(request, { ignoreSearch: true })
        const network = fetch(request).then(res => {
            if (res.ok && res.type === 'basic') cache.put(request, res.clone())
            return res
        })
        if (cached) {
            e.waitUntil(network.catch(() => {}))
            return cached
        }
        return network
    })())
})
