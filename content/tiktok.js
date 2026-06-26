// hixDownloader - TikTok parser and button injection.
//
// Strategy:
//  1. Subscribe to raw interceptor captures and walk the JSON looking for
//     objects that carry a video address (playAddr / downloadAddr) together
//     with an item id. Store id -> { play, download }.
//  2. Inject a download button into each video's right-hand action column.
//  3. On click resolve the real mp4 from the parsed map (preferring the
//     watermark-free playAddr), falling back to the background webRequest store.
//
// Everything is wrapped defensively: a parser or DOM failure must never break
// TikTok itself.

"use strict";

(function () {
  const C = window.__hixCommon;
  if (!C) return; // common.js must load first
  if (window.__hixTikTok) return;
  window.__hixTikTok = true;

  const PLATFORM = "tiktok";

  /** @type {Map<string, {play?: string, download?: string}>} id -> urls */
  const videoMap = new Map();

  /** @type {Map<string, string>} cover-image token -> video id */
  const coverMap = new Map();

  // --- parser --------------------------------------------------------------

  /** Normalize a url-ish value (string or { url-list } array) to a usable string. */
  function cleanUrl(value) {
    let url = value;
    if (Array.isArray(value)) url = value[0];
    // TikTok sometimes nests addresses under { url_list: [...] }.
    if (url && typeof url === "object" && Array.isArray(url.url_list)) {
      url = url.url_list[0];
    }
    return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
  }

  /**
   * Extract the stable object token from a TikTok image url. The token is the
   * path segment before `~tplv` (or the bare filename) and is the same across
   * the API cover and the <video poster> regardless of the rendering variant.
   */
  function coverToken(url) {
    if (!url) return "";
    const s = String(url);
    let m = s.match(/\/([A-Za-z0-9_.\-]{10,})~tplv/);
    if (m) return m[1];
    m = s.match(/\/([A-Za-z0-9_\-]{10,})\.(?:jpe?g|webp|heic|avif)/i);
    return m ? m[1] : "";
  }

  /**
   * Recursively walk a parsed JSON value, recording any node that looks like a
   * TikTok item: has an `id` and a `video` object with play/download addresses.
   * @param {*} node
   * @param {number} depth
   */
  function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 12) return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }

    try {
      const video = node.video;
      const id = node.id || node.aweme_id;
      if (id && video && typeof video === "object") {
        const play = cleanUrl(video.playAddr || video.play_addr || video.playApi);
        const download = cleanUrl(video.downloadAddr || video.download_addr);
        if (play || download) {
          const key = String(id);
          const existing = videoMap.get(key) || {};
          videoMap.set(key, {
            play: play || existing.play,
            download: download || existing.download,
          });
          // Record cover tokens so we can map an on-screen video to this id.
          const covers = [
            video.cover,
            video.originCover,
            video.dynamicCover,
            video.reflowCover,
            video.coverUrl,
          ];
          for (const c of covers) {
            const t = coverToken(cleanUrl(c));
            if (t) coverMap.set(t, key);
          }
        }
      }
    } catch (_) {
      /* ignore malformed node */
    }

    for (const k in node) {
      try {
        walk(node[k], depth + 1);
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * Parse the page's server-rendered JSON state. The first batch of FYP videos
   * is embedded in the HTML (not fetched), so the interceptor never sees them;
   * reading these script tags populates the maps for those initial videos.
   */
  function parseInlineState() {
    try {
      const scripts = [];
      for (const sel of [
        "#__UNIVERSAL_DATA_FOR_REHYDRATION__",
        "#SIGI_STATE",
        "#__NEXT_DATA__",
      ]) {
        const el = document.querySelector(sel);
        if (el) scripts.push(el);
      }
      // Any JSON blob that mentions a play address is worth walking too.
      document.querySelectorAll('script[type="application/json"]').forEach((el) => {
        const t = el.textContent || "";
        if ((t.includes("playAddr") || t.includes("play_addr")) && !scripts.includes(el)) {
          scripts.push(el);
        }
      });

      const before = videoMap.size;
      for (const el of scripts) {
        try {
          walk(JSON.parse(el.textContent), 0);
        } catch (_) {
          /* not valid json / unrelated */
        }
      }
      if (videoMap.size > before) {
        console.log("[hixDownloader] tiktok parsed inline state; total", videoMap.size);
      }
    } catch (_) {
      /* ignore */
    }
  }

  C.onRawCapture((capture) => {
    try {
      if (!capture || !capture.body) return;
      const before = videoMap.size;
      const data = JSON.parse(capture.body);
      walk(data, 0);
      if (videoMap.size > before) {
        console.log(
          "[hixDownloader] tiktok parsed",
          videoMap.size - before,
          "new video url(s); total",
          videoMap.size
        );
      }
    } catch (_) {
      // Not JSON or unparsable; ignore.
    }
  });

  // --- DOM: locate current video id ---------------------------------------

  /** The whole-video container for a node (button lives inside the action bar). */
  function containerOf(node) {
    return (
      C.closestMatch(node, '[data-e2e="recommend-list-item-container"]') ||
      C.closestMatch(node, "article") ||
      C.closestMatch(node, '[class*="DivItemContainer"]') ||
      C.closestMatch(node, '[class*="DivVideoContainer"]') ||
      null
    );
  }

  const ID_RE = /\/(?:video|photo)\/(\d+)/;

  /**
   * Walk up from the clicked node and return the first 18-20 digit id that we
   * have actually captured (exists in videoMap). Tying the id to the clicked
   * button's own subtree makes selection deterministic regardless of which
   * videos were prefetched. The html-size cap stops us from climbing into the
   * whole feed (which would contain every id and be ambiguous).
   */
  function mappedIdFromAncestors(node) {
    let el = node;
    for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
      let html;
      try {
        html = el.outerHTML || "";
      } catch (_) {
        continue;
      }
      if (html.length > 300000) break; // climbed past a single item
      const ids = html.match(/\d{18,20}/g);
      if (ids) {
        for (const cand of ids) {
          if (videoMap.has(cand)) return cand;
        }
      }
    }
    return null;
  }

  /**
   * Match the clicked item's <video> poster (or a cover img in its container)
   * to a captured cover token, yielding the exact video id. Works even for
   * MediaSource videos where the blob has no readable bytes.
   */
  function idFromCover(node) {
    try {
      const v = videoElFor(node);
      const candidates = [];
      if (v) candidates.push(v.getAttribute("poster") || v.poster || "");
      const container = containerOf(node) || (v && v.parentElement);
      if (container && container.querySelectorAll) {
        container.querySelectorAll("img").forEach((img) => {
          candidates.push(img.getAttribute("src") || img.src || "");
          candidates.push(img.getAttribute("srcset") || "");
        });
      }
      for (const url of candidates) {
        const t = coverToken(url);
        if (t && coverMap.has(t)) return coverMap.get(t);
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  /** Find the TikTok video id for the clicked button's video. */
  function videoIdFor(node) {
    // 1) Cover-image correlation: the exact on-screen video, MSE-proof.
    const byCover = idFromCover(node);
    if (byCover) return byCover;

    // 2) A /video/ or /photo/ link inside the clicked item's container.
    const container = containerOf(node);
    if (container) {
      const id = C.idFromHref(container, 'a[href*="/video/"], a[href*="/photo/"]', ID_RE);
      if (id) return id;
    }

    // 3) A captured id appearing in the clicked button's own subtree.
    const mapped = mappedIdFromAncestors(node);
    if (mapped) return mapped;

    // 3) The single-video page URL.
    const m = location.pathname.match(ID_RE);
    if (m) return m[1];

    // 4) Any /video/ id in the container html.
    if (container) {
      try {
        const hm = (container.innerHTML || "").match(ID_RE);
        if (hm) return hm[1];
      } catch (_) {
        /* ignore */
      }
    }

    return null;
  }

  // --- download flow -------------------------------------------------------

  /**
   * Extract TikTok's per-video file token from a CDN URL. The same token
   * appears in both the streaming (webRequest) URL and the API playAddr, so we
   * can match an active video's stream to its clean playAddr.
   * e.g. .../video/tos/alisg/tos-alisg-pve-0037c001/<TOKEN>/?a=...
   */
  function fileToken(url) {
    if (!url) return "";
    const m = String(url).match(/\/video\/tos\/[^/]+\/[^/]+\/([^/?#]+)/);
    return m ? m[1] : "";
  }

  /** Find a captured entry whose play/download URL shares the given token. */
  function entryByToken(token) {
    if (!token) return null;
    for (const [id, e] of videoMap) {
      if (fileToken(e.play) === token || fileToken(e.download) === token) {
        return { id, entry: e };
      }
    }
    return null;
  }

  /** The most visible (and ideally playing) <video> in the viewport. */
  function mostVisibleVideo() {
    let best = null;
    let bestScore = -1;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    document.querySelectorAll("video").forEach((v) => {
      try {
        const r = v.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const score = visH * visW * (v.paused ? 1 : 2);
        if (score > bestScore) {
          bestScore = score;
          best = v;
        }
      } catch (_) {
        /* ignore */
      }
    });
    return best;
  }

  /** The <video> element belonging to the clicked button's own item. */
  function videoElFor(node) {
    // Lowest ancestor that contains a <video>: the clicked item's container.
    let el = node;
    for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
      try {
        const vids = el.querySelectorAll && el.querySelectorAll("video");
        if (vids && vids.length === 1) return vids[0]; // unambiguous: its own video
        if (vids && vids.length > 1) break; // ambiguous container; use visibility
      } catch (_) {
        /* ignore */
      }
    }
    // Ambiguous or not found: the video the user is actually looking at.
    return mostVisibleVideo();
  }

  /** Real CDN url for the clicked item's video element, via blob mapping or direct src. */
  function urlFromVideoEl(node) {
    const v = videoElFor(node);
    if (!v) return "";
    const src = v.currentSrc || v.src || "";
    if (/^https?:\/\//i.test(src)) return src; // progressive, direct url
    if (src.startsWith("blob:")) return C.realUrlForBlob(src); // mapped real url
    return "";
  }

  /**
   * Resolve a downloadable mp4. Priority:
   *  1) The clicked video element's real url (deterministic, exact on-screen video).
   *  2) DOM id -> captured playAddr.
   *  3) Active stream token -> captured playAddr (webRequest).
   *  4) Raw webRequest url as a last resort.
   * @returns {Promise<{url: string, source: string, id: string|null}>}
   */
  async function resolveUrl(node, id) {
    // 1) Exact on-screen video, mapped from its blob/direct src.
    const elUrl = urlFromVideoEl(node);
    if (elUrl) {
      const hit = entryByToken(fileToken(elUrl));
      return { url: elUrl, source: "video-el", id: (hit && hit.id) || id };
    }

    // 2) DOM id -> captured playAddr.
    const entry = id ? videoMap.get(String(id)) : null;
    if (entry && (entry.play || entry.download)) {
      // playAddr is watermark-free; downloadAddr carries the watermark.
      return {
        url: entry.play || entry.download,
        source: entry.play ? "playAddr" : "downloadAddr",
        id,
      };
    }

    // 3) Match a recent stream token to a captured playAddr (webRequest).
    const res = await C.sendMessage(C.MSG.GET_CAPTURES, {});
    const items = (res && res.ok && res.items) || [];
    for (const item of items) {
      const hit = entryByToken(fileToken(item.url));
      if (hit && (hit.entry.play || hit.entry.download)) {
        return { url: hit.entry.play || hit.entry.download, source: "token-match", id: hit.id };
      }
    }

    // 4) Last resort: hand the raw stream URL to the downloader.
    if (items.length) {
      return { url: items[0].url, source: "webRequest", id: null };
    }
    return { url: "", source: "none", id: null };
  }

  /** Build the saved filename for a given id. */
  function makeFilename(id) {
    return `hixDownloader_${PLATFORM}_${id || Date.now()}.mp4`;
  }

  /**
   * Download the exact bytes backing the clicked item's <video> element. Its
   * currentSrc is a page blob: URL that only the MAIN world can read, so we hand
   * it to the interceptor to fetch + save. No CDN url, Referer or id correlation.
   * Returns true on success, false to let the caller fall back.
   */
  async function downloadFromElement(node, id) {
    const v = videoElFor(node);
    const src = v && (v.currentSrc || v.src || "");
    if (!src || !src.startsWith("blob:")) return false;

    const r = await C.downloadPageBlob(src, makeFilename(id));
    if (r && r.ok) {
      console.log("[hixDownloader] tiktok direct blob download:", r.size, "bytes");
      return true;
    }
    console.warn("[hixDownloader] tiktok direct blob failed:", r && r.reason);
    return false;
  }

  async function onDownloadClick(btn, node) {
    C.setButtonState(btn, "loading");
    try {
      let id = videoIdFor(node);
      // If unknown, the first (server-rendered) batch may not be parsed yet.
      if (!id) {
        parseInlineState();
        id = videoIdFor(node);
      }

      // Primary: download the exact on-screen video element's bytes.
      const direct = await downloadFromElement(node, id);
      if (direct) {
        C.setButtonState(btn, "done");
        C.toast("Download started", "success");
        return;
      }

      // Fallback: resolve a CDN url and download it via the background worker.
      const resolved = await resolveUrl(node, id);
      const { url, source } = resolved;
      const fid = resolved.id || id;
      console.log("[hixDownloader] tiktok resolve:", { id: fid, source, url, mapped: videoMap.size });
      if (!url) {
        C.setButtonState(btn, "error");
        C.toast("No video URL captured yet — let it play a moment.", "error");
        return;
      }
      const res = await C.requestDownload({ url, platform: PLATFORM, id: fid });
      if (res && res.ok) {
        C.setButtonState(btn, "done");
        C.toast("Download started", "success");
      } else {
        C.setButtonState(btn, "error");
        C.toast((res && res.error) || "Download failed", "error");
      }
    } catch (err) {
      C.setButtonState(btn, "error");
      C.toast("Download failed", "error");
      console.warn("[hixDownloader] tiktok download failed:", err);
    } finally {
      setTimeout(() => C.setButtonState(btn, null), 2000);
    }
  }

  // --- button injection ----------------------------------------------------

  /** The whole-video container, used to keep injection to one button per video. */
  function videoContainerFor(node) {
    return (
      C.closestMatch(node, '[data-e2e="recommend-list-item-container"]') ||
      C.closestMatch(node, "article") ||
      C.closestMatch(node, '[class*="DivItemContainer"]') ||
      C.closestMatch(node, '[class*="DivVideoContainer"]') ||
      null
    );
  }

  /**
   * Inject one download button per visible video. We anchor on the like icon
   * (one per video), dedup by the video container, and place our button right
   * after the like action item so it lives inside the same action bar.
   */
  function injectButtons() {
    let anchors;
    try {
      anchors = document.querySelectorAll('[data-e2e="like-icon"]');
    } catch (_) {
      return;
    }

    anchors.forEach((likeIcon) => {
      try {
        // Scope = the whole video; falls back to the action bar wrapper.
        const likeItem =
          C.closestMatch(likeIcon, '[class*="DivActionItemContainer"]') ||
          likeIcon.parentElement;
        const scope = videoContainerFor(likeIcon) || (likeItem && likeItem.parentElement);
        if (!scope) return;
        if (scope.querySelector(`.${C.BTN_CLASS}`)) return; // already injected

        const btn = C.createDownloadButton({
          variant: "tiktok",
          title: "Download with hixDownloader",
          onClick: () => onDownloadClick(btn, likeIcon),
        });
        const wrap = document.createElement("div");
        wrap.className = "hix-action-item";
        wrap.style.display = "flex";
        wrap.style.flexDirection = "column";
        wrap.style.alignItems = "center";
        wrap.style.margin = "8px 0";
        wrap.appendChild(btn);

        // Place our item right after the like item, inside the action bar.
        if (likeItem && likeItem.parentElement) {
          likeItem.parentElement.insertBefore(wrap, likeItem.nextSibling);
        } else if (likeItem) {
          likeItem.appendChild(wrap);
        }
      } catch (err) {
        console.warn("[hixDownloader] tiktok inject failed:", err);
      }
    });
  }

  C.observe(injectButtons);

  // Parse server-rendered state for the initial batch, with a few retries in
  // case the script tags are injected slightly after the content script runs.
  parseInlineState();
  [500, 1500, 3000].forEach((ms) => setTimeout(parseInlineState, ms));

  console.debug("[hixDownloader] tiktok content script ready");
})();
