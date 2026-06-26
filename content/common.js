// hixDownloader - shared content-script helpers.
//
// Task 2 adds the content side of the content <-> background message bridge.
// Button factory, current-video id detection and toast helpers land in a later task.

"use strict";

(function () {
  // Avoid re-defining when injected more than once.
  if (window.__hixCommon) return;

  // Keep in sync with background.js MSG constants.
  const MSG = {
    DOWNLOAD: "hix:download",
    GET_CAPTURES: "hix:getCaptures",
    PING: "hix:ping",
  };

  /**
   * Send a message to the background worker. Always resolves (never rejects) so
   * callers can rely on a stable { ok, ... } shape even if the worker is asleep
   * or the context is invalidated.
   * @param {string} type
   * @param {object} [payload]
   * @returns {Promise<object>}
   */
  function sendMessage(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(response || { ok: false, error: "empty response" });
        });
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }

  /** Request a background download. */
  function requestDownload({ url, platform, id, filename }) {
    return sendMessage(MSG.DOWNLOAD, { url, platform, id, filename });
  }

  window.__hixCommon = { MSG, sendMessage, requestDownload };
})();
