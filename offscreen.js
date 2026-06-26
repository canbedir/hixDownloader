// hixDownloader - offscreen document.
//
// Fetches video bytes on behalf of the background worker. Running here (an
// extension page) means host_permissions bypass page CORS, cookies are sent,
// and the Referer set by declarativeNetRequest applies. We validate the
// response really is a video, then create a blob URL the background can
// hand to chrome.downloads.

"use strict";

const MIN_VIDEO_BYTES = 2048; // anything smaller is an error page, not a video

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "hix:offscreenRevoke") {
    try {
      URL.revokeObjectURL(msg.url);
    } catch (_) {
      /* ignore */
    }
    return; // no response needed
  }

  if (msg.type !== "hix:offscreenFetch") return;

  (async () => {
    try {
      const resp = await fetch(msg.url, { credentials: "include" });
      const ct = (resp.headers.get("content-type") || "").toLowerCase();

      if (!resp.ok) {
        sendResponse({ ok: false, error: `http ${resp.status}` });
        return;
      }
      // Reject obvious non-video responses (login/error/JSON pages).
      if (ct.includes("text/html") || ct.includes("application/json") || ct.startsWith("text/")) {
        sendResponse({ ok: false, error: `not a video (content-type: ${ct || "unknown"})` });
        return;
      }

      const blob = await resp.blob();
      if (blob.size < MIN_VIDEO_BYTES) {
        sendResponse({ ok: false, error: `response too small (${blob.size}B)` });
        return;
      }

      const blobUrl = URL.createObjectURL(blob);
      sendResponse({ ok: true, blobUrl, size: blob.size, mime: ct });
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();

  return true; // keep the channel open for the async response
});
