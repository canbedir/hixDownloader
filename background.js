// hixDownloader - background service worker.
//
// Hosts the content <-> background message bridge. Real download logic and the
// webRequest fallback store arrive in later tasks; for now the handlers are stubs
// that keep the message contract stable so content scripts can be built against it.

"use strict";

// Message types exchanged between content scripts / popup and the background worker.
const MSG = {
  DOWNLOAD: "hix:download", // { url, platform, id, filename? } -> { ok, downloadId? , error? }
  GET_CAPTURES: "hix:getCaptures", // {} -> { ok, items: [] }
  PING: "hix:ping", // {} -> { ok: true }
};

/**
 * Stub download handler. Replaced by the real chrome.downloads.download wrapper
 * in a later task. Always resolves so callers can rely on a stable shape.
 * @param {{url?: string, platform?: string, id?: string, filename?: string}} payload
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function handleDownload(payload) {
  try {
    if (!payload || !payload.url) {
      return { ok: false, error: "missing url" };
    }
    // TODO(task 4): trigger chrome.downloads.download and return the downloadId.
    console.debug("[hixDownloader] download requested (stub):", payload);
    return { ok: false, error: "download not implemented yet" };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * Stub capture lookup. Replaced by the per-tab webRequest store in a later task.
 * @returns {Promise<{ok: boolean, items: Array<object>}>}
 */
async function handleGetCaptures() {
  // TODO(task 5): return the captured .mp4 URLs for the requesting tab.
  return { ok: true, items: [] };
}

/**
 * Central message router. Returns true to keep the sendResponse channel open
 * for the async handlers.
 */
function onMessage(message, sender, sendResponse) {
  const type = message && message.type;

  switch (type) {
    case MSG.PING:
      sendResponse({ ok: true });
      return false;

    case MSG.DOWNLOAD:
      handleDownload(message.payload).then(sendResponse);
      return true;

    case MSG.GET_CAPTURES:
      handleGetCaptures(message.payload, sender).then(sendResponse);
      return true;

    default:
      // Unknown message: respond so the caller's promise settles.
      sendResponse({ ok: false, error: "unknown message type" });
      return false;
  }
}

chrome.runtime.onMessage.addListener(onMessage);

chrome.runtime.onInstalled.addListener((details) => {
  console.debug("[hixDownloader] installed:", details.reason);
});
