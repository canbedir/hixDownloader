# hixDownloader

A Manifest V3 browser extension that adds a one-click **download button** to videos on
**TikTok**, **Instagram** and **Twitter/X**.

## How it works

Video elements on these platforms usually expose a `blob:` URL that cannot be downloaded
directly. hixDownloader captures the real `.mp4` address from two sources:

1. A **MAIN-world interceptor** that safely wraps the page's `fetch` / `XMLHttpRequest`
   and extracts real video URLs from API/JSON responses.
2. A read-only **`webRequest` fallback** in the background service worker that records
   `.mp4` requests per tab.

Downloads run in the background via `chrome.downloads.download`, bypassing page CORS and
pulling the file straight from the CDN.

## Features

- **TikTok:** download button in the right-hand action column.
- **Instagram:** download button in reels and post action rows.
- **Twitter/X:** hover overlay download button (primary) with best-effort context-menu injection.
- **Popup:** universal fallback that lists videos captured on the active tab for manual download.

## Supported browsers

Chrome / Edge / Brave (Manifest V3). Firefox support is planned for later.

## Installation (development)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Project structure

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, content-script declarations |
| `interceptor.js` | MAIN-world fetch/XHR wrapper, extracts real video URLs |
| `content/common.js` | Shared helpers (button factory, current-video id, toast, messaging) |
| `content/tiktok.js` | TikTok parser + button injection |
| `content/twitter.js` | Twitter/X parser + overlay button |
| `content/instagram.js` | Instagram parser + button injection |
| `background.js` | Download service, webRequest capture, per-tab URL store, context menus |
| `styles/buttons.css` | Button and toast styles |
| `popup.html` / `popup.js` | Universal fallback UI |
| `icons/` | Extension icons (16/48/128 px) |

## Disclaimer

For personal use only. Respect the rights of content creators and the terms of service of
each platform.
