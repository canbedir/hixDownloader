// hixDownloader - shared content-script helpers.
//
// Provides the content <-> background message bridge, the interceptor bridge,
// plus shared UI helpers (download button factory, toast) and small DOM utils
// consumed by the per-platform content scripts.

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

  // Maps a <video> element's blob src to the real CDN url the page fetched for
  // it, populated by the interceptor's createObjectURL pairing. This lets a
  // platform script resolve the *exact* on-screen video deterministically.
  const blobToReal = new Map();
  const MAX_BLOB_MAP = 60;

  /**
   * Subscribe to raw captures from the interceptor.
   * @param {(capture: {url: string, body: string, ts: number}) => void} fn
   * @returns {() => void} unsubscribe
   */
  function onRawCapture(fn) {
    captureSubscribers.add(fn);
    return () => captureSubscribers.delete(fn);
  }

  /** Resolve a blob: url (a video element's src) to its real CDN url, if known. */
  function realUrlForBlob(blobUrl) {
    return blobUrl ? blobToReal.get(blobUrl) || "" : "";
  }

  /**
   * Ask the MAIN-world interceptor to download a page blob: URL. Only the world
   * that created the blob can read it, so the actual fetch/save happens there.
   * Resolves with { ok, size?, reason? }.
   * @param {string} blobUrl
   * @param {string} filename
   * @param {number} [timeoutMs]
   */
  function downloadPageBlob(blobUrl, filename, timeoutMs) {
    return new Promise((resolve) => {
      const reqId = "b" + Date.now() + "_" + Math.random().toString(36).slice(2);
      let done = false;
      const onMsg = (event) => {
        try {
          if (event.source !== window) return;
          const d = event.data;
          if (!d || d.source !== BRIDGE_SOURCE) return;
          if (d.kind !== "download-blob-result" || d.reqId !== reqId) return;
          done = true;
          window.removeEventListener("message", onMsg);
          resolve(d);
        } catch (_) {
          /* ignore */
        }
      };
      window.addEventListener("message", onMsg);
      try {
        window.postMessage(
          { source: BRIDGE_SOURCE, kind: "download-blob", blobUrl, filename, reqId },
          location.origin
        );
      } catch (err) {
        window.removeEventListener("message", onMsg);
        resolve({ ok: false, reason: String((err && err.message) || err) });
        return;
      }
      setTimeout(() => {
        if (!done) {
          window.removeEventListener("message", onMsg);
          resolve({ ok: false, reason: "timeout" });
        }
      }, timeoutMs || 20000);
    });
  }

  window.addEventListener("message", (event) => {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== BRIDGE_SOURCE) return;

      if (data.kind === "blob-map") {
        if (data.blobUrl && data.realUrl) {
          blobToReal.set(data.blobUrl, data.realUrl);
          // Bound the map so it can't grow without limit on long sessions.
          if (blobToReal.size > MAX_BLOB_MAP) {
            const firstKey = blobToReal.keys().next().value;
            blobToReal.delete(firstKey);
          }
        }
        return;
      }

      if (data.kind !== BRIDGE_KIND) return;

      const capture = { url: data.url, body: data.body, ts: data.ts };
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

  // --- shared UI: download button factory ---------------------------------
  const BTN_CLASS = "hix-download-btn";

  // Inline SVG download glyph, sized to inherit the button's color/size.
  const DOWNLOAD_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>';

  /**
   * Create a hixDownloader download button.
   * @param {object} [opts]
   * @param {string} [opts.title] - accessible label / tooltip.
   * @param {string} [opts.variant] - extra class suffix, e.g. "tiktok", "overlay".
   * @param {(ev: MouseEvent) => void} [opts.onClick]
   * @returns {HTMLButtonElement}
   */
  function createDownloadButton(opts) {
    const o = opts || {};
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = o.variant ? `${BTN_CLASS} ${BTN_CLASS}--${o.variant}` : BTN_CLASS;
    btn.title = o.title || "Download video";
    btn.setAttribute("aria-label", btn.title);
    btn.dataset.hix = "1";
    btn.innerHTML = DOWNLOAD_ICON_SVG;

    if (typeof o.onClick === "function") {
      btn.addEventListener("click", (ev) => {
        // Keep the host UI from reacting to our click (like/scroll/navigate).
        ev.preventDefault();
        ev.stopPropagation();
        try {
          o.onClick(ev);
        } catch (err) {
          console.warn("[hixDownloader] button click failed:", err);
        }
      });
    }
    return btn;
  }

  /** Set the button into a transient state (loading / done / error). */
  function setButtonState(btn, state) {
    if (!btn) return;
    btn.classList.remove("is-loading", "is-done", "is-error");
    if (state) btn.classList.add(`is-${state}`);
  }

  // --- shared UI: toast ----------------------------------------------------
  let toastTimer = null;

  /**
   * Show a brief toast message. Self-contained; never throws.
   * @param {string} message
   * @param {"info"|"success"|"error"} [type]
   */
  function toast(message, type) {
    try {
      let el = document.getElementById("hix-toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "hix-toast";
        document.documentElement.appendChild(el);
      }
      el.textContent = message;
      el.className = `hix-toast hix-toast--${type || "info"} is-visible`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.classList.remove("is-visible");
      }, 2600);
    } catch (_) {
      /* never break the page */
    }
  }

  // --- shared DOM utils ----------------------------------------------------
  /** Extract a numeric/short id from an href matching a pattern's capture group. */
  function idFromHref(root, selector, regex) {
    try {
      const scope = root || document;
      const links = scope.querySelectorAll(selector);
      for (const a of links) {
        const href = a.getAttribute("href") || a.href || "";
        const m = href.match(regex);
        if (m && m[1]) return m[1];
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  /** Find the closest ancestor matching selector, tolerant of detached nodes. */
  function closestMatch(node, selector) {
    try {
      return node && node.closest ? node.closest(selector) : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Observe DOM mutations and run a (debounced) callback. Returns a disconnect fn.
   * Used by platform scripts to (re)inject buttons as feeds re-render.
   * @param {() => void} cb
   * @returns {() => void}
   */
  function observe(cb) {
    let scheduled = false;
    const run = () => {
      scheduled = false;
      try {
        cb();
      } catch (err) {
        console.warn("[hixDownloader] observe callback failed:", err);
      }
    };
    const mo = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      // rAF keeps us off the critical mutation path.
      requestAnimationFrame(run);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Run once immediately so existing nodes are handled.
    run();
    return () => mo.disconnect();
  }

  window.__hixCommon = {
    MSG,
    sendMessage,
    requestDownload,
    onRawCapture,
    realUrlForBlob,
    downloadPageBlob,
    createDownloadButton,
    setButtonState,
    toast,
    idFromHref,
    closestMatch,
    observe,
    BTN_CLASS,
  };
})();
