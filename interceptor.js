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

  // --- blob -> real url correlation ---------------------------------------
  // TikTok fetches an mp4 then assigns it to a <video> via
  // URL.createObjectURL(blob). We queue freshly-fetched video URLs and pair
  // each with the next createObjectURL call, so the ISOLATED side can map an
  // active video element's blob src back to its real CDN url. This is the only
  // fully deterministic way to know which video is on screen.
  // Each pending entry is { url, size } where size is the response's
  // Content-Length. We pair a created blob to the pending fetch whose size
  // equals blob.size, which is order-independent and therefore reliable.
  const pendingVideos = [];
  const MAX_PENDING = 40;

  /** True when a response looks like a video stream we can download. */
  function isVideoResponse(url, contentType) {
    const ct = (contentType || "").toLowerCase();
    if (ct.startsWith("video/")) return true;
    return /\/video\/tos\//i.test(url) || /mime_type=video_mp4/i.test(url);
  }

  function pushPendingVideo(url, size) {
    try {
      if (!url) return;
      if (pendingVideos.some((p) => p.url === url && p.size === size)) return;
      pendingVideos.push({ url, size: size || 0 });
      if (pendingVideos.length > MAX_PENDING) pendingVideos.shift();
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Pull the pending video url for a created blob. Prefer an exact size match
   * (Content-Length === blob.size); fall back to FIFO when size is unknown.
   */
  function takePendingForBlob(blobSize) {
    try {
      if (blobSize) {
        const i = pendingVideos.findIndex((p) => p.size === blobSize);
        if (i !== -1) return pendingVideos.splice(i, 1)[0].url;
      }
      // No size info recorded: best-effort FIFO.
      const fifo = pendingVideos.find((p) => !p.size);
      if (fifo) {
        pendingVideos.splice(pendingVideos.indexOf(fifo), 1);
        return fifo.url;
      }
    } catch (_) {
      /* ignore */
    }
    return "";
  }

  function postBlobMap(blobUrl, realUrl) {
    try {
      if (!blobUrl || !realUrl) return;
      window.postMessage(
        { source: BRIDGE_SOURCE, kind: "blob-map", blobUrl, realUrl, ts: Date.now() },
        location.origin
      );
      console.debug("[hixDownloader] blob map", blobUrl, "->", realUrl);
    } catch (_) {
      /* never break the page */
    }
  }

  // Wrap URL.createObjectURL to pair blobs with the most recent video fetch.
  try {
    const origCreate = URL.createObjectURL;
    if (typeof origCreate === "function") {
      URL.createObjectURL = function (obj) {
        const blobUrl = origCreate.apply(this, arguments);
        try {
          if (obj instanceof Blob && pendingVideos.length) {
            const t = obj.type || "";
            const looksVideo = t.startsWith("video") || (t === "" && obj.size > 200000);
            if (looksVideo) {
              const real = takePendingForBlob(obj.size);
              if (real) postBlobMap(blobUrl, real);
            }
          }
        } catch (_) {
          /* ignore */
        }
        return blobUrl;
      };
    }
  } catch (_) {
    /* leave native createObjectURL in place */
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
                // Video stream: record the url + size for blob pairing.
                if (isVideoResponse(url, ct)) {
                  const len = response.headers && response.headers.get("content-length");
                  pushPendingVideo(url, len ? parseInt(len, 10) : 0);
                  return;
                }
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

  // --- blob download (MAIN world) -----------------------------------------
  // Only the world that created a blob: URL can read it, so the ISOLATED content
  // script delegates the actual save here. We fetch the page's own blob, verify
  // it carries real bytes, then trigger an anchor download with the filename.
  async function handleDownloadBlob(blobUrl, filename, reqId) {
    let ok = false;
    let size = 0;
    let reason = "";
    try {
      if (!blobUrl || !blobUrl.startsWith("blob:")) {
        reason = "not a blob url";
      } else {
        const resp = await fetch(blobUrl);
        if (!resp.ok) {
          reason = "http " + resp.status;
        } else {
          const blob = await resp.blob();
          size = blob.size;
          if (size < 4096) {
            // MediaSource-backed blobs return little/nothing.
            reason = "too small (" + size + ")";
          } else {
            const u = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = u;
            a.download = filename || "hixDownloader.mp4";
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => {
              try {
                URL.revokeObjectURL(u);
              } catch (_) {
                /* ignore */
              }
            }, 60000);
            ok = true;
          }
        }
      }
    } catch (err) {
      reason = String((err && err.message) || err);
    }
    try {
      window.postMessage(
        { source: BRIDGE_SOURCE, kind: "download-blob-result", reqId, ok, size, reason },
        location.origin
      );
    } catch (_) {
      /* ignore */
    }
  }

  window.addEventListener("message", (event) => {
    try {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.source !== BRIDGE_SOURCE || d.kind !== "download-blob") return;
      handleDownloadBlob(d.blobUrl, d.filename, d.reqId);
    } catch (_) {
      /* never break the page */
    }
  });

  console.debug("[hixDownloader] interceptor installed");
})();
