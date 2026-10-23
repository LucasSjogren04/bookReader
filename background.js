// Clicking the toolbar icon opens the reader page, or focuses it if it is already open.
const READER_URL = chrome.runtime.getURL('reader.html')

chrome.action.onClicked.addListener(async () => {
    const [tab] = await chrome.tabs.query({ url: READER_URL + '*' })
    if (tab) {
        await chrome.tabs.update(tab.id, { active: true })
        await chrome.windows.update(tab.windowId, { focused: true })
    } else {
        await chrome.tabs.create({ url: READER_URL })
    }
})
