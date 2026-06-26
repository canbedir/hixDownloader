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

  // --- interceptor bridge (ISOLATED side) ---------------------------------
  // The MAIN-world interceptor posts raw response bodies here via postMessage.
  // Subscribers (per-platform parsers, added later) register a callback to turn
  // those bodies into { id -> mp4Url } maps. For now we just expose the plumbing
  // and log, so the bridge is verifiable end-to-end without any parser yet.
  const BRIDGE_SOURCE = "hixDownloader";
  const BRIDGE_KIND = "raw-capture";
  const captureSubscribers = new Set();

  /**
   * Subscribe to raw captures from the interceptor.
   * @param {(capture: {url: string, body: string, ts: number}) => void} fn
   * @returns {() => void} unsubscribe
   */
  function onRawCapture(fn) {
    captureSubscribers.add(fn);
    return () => captureSubscribers.delete(fn);
  }

  window.addEventListener("message", (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== BRIDGE_SOURCE || data.kind !== BRIDGE_KIND) return;

      const capture = { url: data.url, body: data.body, ts: data.ts };
      console.debug("[hixDownloader] bridge received capture from", capture.url);
      for (const fn of captureSubscribers) {
        try {
          fn(capture);
        } catch (_) {
          /* one bad subscriber must not break the rest */
        }
      }
    } catch (_) {
      /* never break the page */
    }
  });

  window.__hixCommon = { MSG, sendMessage, requestDownload, onRawCapture };
})();
