// hixDownloader - MAIN world interceptor.
//
// Runs at document_start in the page's own JS context so it can wrap the page's
// fetch / XMLHttpRequest. It captures API/JSON responses from relevant hosts and
// forwards the raw text to the ISOLATED content script via window.postMessage.
//
// This task only does *raw* capture + logging. Platform-specific parsing of the
// captured bodies into { id -> mp4Url } happens in later tasks (in the ISOLATED
// world), so the interceptor stays generic and resilient.
//
// Hard rule: never break the site. Every wrapper falls back to the original
// behaviour on any error, and response bodies are read from clones only.

(function () {
  "use strict";

  // Guard against double injection.
  if (window.__hixInterceptorInstalled) return;
  window.__hixInterceptorInstalled = true;

  // Bridge channel marker. The ISOLATED content script listens for this.
  const BRIDGE_SOURCE = "hixDownloader";
  const BRIDGE_KIND = "raw-capture";

  // Only forward bodies from hosts whose APIs carry video metadata. Keeps the
  // bridge quiet and avoids touching unrelated traffic.
  const HOST_PATTERNS = [
    /tiktok\.com$/i,
    /(^|\.)x\.com$/i,
    /twitter\.com$/i,
    /instagram\.com$/i,
  ];

  // Cap forwarded body size so we never ship huge payloads (e.g. media) across.
  const MAX_BODY_LENGTH = 2_000_000; // ~2 MB of text

  /** Resolve a request URL to an absolute string, tolerating Request objects. */
  function resolveUrl(input) {
    try {
      if (typeof input === "string") return new URL(input, location.href).href;
      if (input && typeof input.url === "string") {
        return new URL(input.url, location.href).href;
      }
    } catch (_) {
      /* ignore */
    }
    return "";
  }

  /** True when the URL host is one we care about. */
  function isRelevantUrl(url) {
    try {
      const host = new URL(url, location.href).hostname;
      return HOST_PATTERNS.some((re) => re.test(host));
    } catch (_) {
      return false;
    }
  }

  /** Looks like a JSON / text API response we can parse later (skip media). */
  function isTextualContentType(contentType) {
    if (!contentType) return true; // unknown -> attempt, parser is defensive
    const ct = contentType.toLowerCase();
    return ct.includes("json") || ct.includes("text") || ct.includes("javascript");
  }

  /**
   * Forward a captured body to the ISOLATED world. Never throws.
   * @param {string} url
   * @param {string} body
   */
  function postRawCapture(url, body) {
    try {
      if (!body) return;
      const text = body.length > MAX_BODY_LENGTH ? "" : body;
      if (!text) return;
      window.postMessage(
        {
          source: BRIDGE_SOURCE,
          kind: BRIDGE_KIND,
          url,
          body: text,
          ts: Date.now(),
        },
        location.origin
      );
      // Lightweight breadcrumb; parsing/extraction comes later.
      console.debug("[hixDownloader] captured response from", url, `(${text.length} bytes)`);
    } catch (_) {
      /* never break the page */
    }
  }

  // --- fetch wrapper -------------------------------------------------------
  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function (input, init) {
        const url = resolveUrl(input);
        const promise = originalFetch.apply(this, arguments);

        if (url && isRelevantUrl(url)) {
          promise
            .then((response) => {
              try {
                const ct = response.headers && response.headers.get("content-type");
                if (!isTextualContentType(ct)) return;
                // Read from a clone so the page's consumer is untouched.
                response
                  .clone()
                  .text()
                  .then((body) => postRawCapture(url, body))
                  .catch(() => {});
              } catch (_) {
                /* ignore */
              }
            })
            .catch(() => {});
        }

        return promise;
      };
    }
  } catch (_) {
    /* leave native fetch in place */
  }

  // --- XMLHttpRequest wrapper ---------------------------------------------
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const open = XHR.prototype.open;
      const send = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        try {
          this.__hixUrl = resolveUrl(url);
        } catch (_) {
          this.__hixUrl = "";
        }
        return open.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        try {
          const url = this.__hixUrl;
          if (url && isRelevantUrl(url)) {
            this.addEventListener("load", function () {
              try {
                const ct = this.getResponseHeader && this.getResponseHeader("content-type");
                if (!isTextualContentType(ct)) return;
                // Only string-like response types expose responseText safely.
                const rt = this.responseType;
                if (rt === "" || rt === "text") {
                  postRawCapture(url, this.responseText || "");
                }
              } catch (_) {
                /* ignore */
              }
            });
          }
        } catch (_) {
          /* ignore */
        }
        return send.apply(this, arguments);
      };
    }
  } catch (_) {
    /* leave native XHR in place */
  }

  console.debug("[hixDownloader] interceptor installed");
})();
