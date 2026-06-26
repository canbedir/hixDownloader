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

  C.onRawCapture((capture) => {
    try {
      if (!capture || !capture.body) return;
      const data = JSON.parse(capture.body);
      walk(data, 0);
    } catch (_) {
      // Not JSON or unparsable; ignore.
    }
  });

  // --- DOM: locate current video id ---------------------------------------

  /** Find the TikTok video id associated with a node's nearest container. */
  function videoIdFor(node) {
    // Prefer an id from a link within the same article/container.
    const container =
      C.closestMatch(node, '[data-e2e="recommend-list-item-container"]') ||
      C.closestMatch(node, "article") ||
      C.closestMatch(node, '[class*="DivItemContainer"]') ||
      document;
    const id = C.idFromHref(container, 'a[href*="/video/"]', /\/video\/(\d+)/);
    if (id) return id;
    // Fallback: id from the page URL on a single-video page.
    const m = location.pathname.match(/\/video\/(\d+)/);
    return m ? m[1] : null;
  }

  // --- download flow -------------------------------------------------------

  async function resolveUrl(id) {
    const entry = id ? videoMap.get(String(id)) : null;
    if (entry && (entry.play || entry.download)) {
      return entry.play || entry.download; // playAddr is watermark-free
    }
    // Fallback to the background webRequest store for this tab.
    const res = await C.sendMessage(C.MSG.GET_CAPTURES, {});
    if (res && res.ok && res.items && res.items.length) {
      return res.items[0].url;
    }
    return "";
  }

  async function onDownloadClick(btn, node) {
    C.setButtonState(btn, "loading");
    try {
      const id = videoIdFor(node);
      const url = await resolveUrl(id);
      if (!url) {
        C.setButtonState(btn, "error");
        C.toast("No video URL captured yet — let it play a moment.", "error");
        return;
      }
      const res = await C.requestDownload({ url, platform: PLATFORM, id });
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

  /** Right-hand action columns: target the share/like/comment icon group. */
  function findActionColumns() {
    const selectors = [
      '[class*="DivActionItemContainer"]',
      '[class*="ActionItemContainer"]',
      '[data-e2e="share-icon"]',
      '[data-e2e="like-icon"]',
    ];
    const found = new Set();
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          // Walk up to the column wrapper holding the action buttons.
          const col =
            C.closestMatch(el, '[class*="DivActionItemContainer"]') ||
            (el.parentElement && el.parentElement.parentElement) ||
            el.parentElement;
          if (col) found.add(col);
        });
      } catch (_) {
        /* ignore selector */
      }
    }
    return [...found];
  }

  function injectButtons() {
    const columns = findActionColumns();
    for (const col of columns) {
      try {
        if (col.querySelector(`.${C.BTN_CLASS}`)) continue;
        const btn = C.createDownloadButton({
          variant: "tiktok",
          title: "Download with hixDownloader",
          onClick: () => onDownloadClick(btn, col),
        });
        const wrap = document.createElement("div");
        wrap.className = "hix-action-item";
        wrap.style.display = "flex";
        wrap.style.justifyContent = "center";
        wrap.style.marginTop = "8px";
        wrap.appendChild(btn);
        col.appendChild(wrap);
      } catch (err) {
        console.warn("[hixDownloader] tiktok inject failed:", err);
      }
    }
  }

  C.observe(injectButtons);
  console.debug("[hixDownloader] tiktok content script ready");
})();
