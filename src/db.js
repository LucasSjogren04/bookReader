// IndexedDB wrapper. Three stores:
//   books  – library metadata (title, author, cover, progress…)
//   files  – the original book file as a Blob
//   cache  – conversion results that are expensive to recompute (PDF page analysis)

const DB_NAME = 'shelf'
const DB_VERSION = 1

let dbPromise
const open = () => dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files')
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
})

const promisify = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
})

const tx = async (stores, mode, fn) => {
    const db = await open()
    const t = db.transaction(stores, mode)
    const result = fn(...[stores].flat().map(name => t.objectStore(name)))
    await new Promise((resolve, reject) => {
        t.oncomplete = resolve
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error ?? new Error('Transaction aborted'))
    })
    return result instanceof IDBRequest ? result.result : result
}

export const listBooks = () => tx('books', 'readonly', s => s.getAll())
export const getBook = id => tx('books', 'readonly', s => s.get(id))
export const putBook = book => tx('books', 'readwrite', s => s.put(book))
export const getFile = id => tx('files', 'readonly', s => s.get(id))
export const getCache = id => tx('cache', 'readonly', s => s.get(id))
export const putCache = (id, value) => tx('cache', 'readwrite', s => s.put(value, id))

export const addBook = (book, file) => tx(['books', 'files'], 'readwrite', (books, files) => {
    books.put(book)
    files.put(file, book.id)
})

export const updateBook = async (id, patch) => {
    const db = await open()
    const t = db.transaction('books', 'readwrite')
    const store = t.objectStore('books')
    const book = await promisify(store.get(id))
    if (book) store.put(Object.assign(book, patch))
    return new Promise((resolve, reject) => {
        t.oncomplete = () => resolve(book)
        t.onerror = () => reject(t.error)
    })
}

export const deleteBook = id => tx(['books', 'files', 'cache'], 'readwrite', (books, files, cache) => {
    books.delete(id)
    files.delete(id)
    cache.delete(id)
})
