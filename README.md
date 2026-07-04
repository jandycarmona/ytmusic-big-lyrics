# Big Lyrics for YouTube Music

Spotify-style synced lyrics for **YouTube Music** — big, readable, auto-scrolling lyrics with the current line highlighted, so you can sing along even to the parts you don't remember.

Works on `music.youtube.com` in Chrome/Edge **and inside the YouTube Music desktop app** (the one you install from Chrome), since that app is a Chrome PWA and runs your browser extensions.

## Features

- 🎤 **Synced lyrics** — the current line is highlighted and auto-scrolls as the song plays, powered by [LRCLIB](https://lrclib.net) (free and open lyrics database).
- 🖱️ **Click-to-seek** — click any line to jump to that part of the song.
- 🧭 **Explore freely** — scrolling manually pauses auto-scroll so you can browse the lyrics in peace; a *"Back to the current line"* pill brings you back and re-enables auto-scroll (clicking a line does too).
- 🪟 **Two view modes** (remembered between sessions):
  - **Panel mode** — lyrics on the left, blended into the app's design, leaving the *Up next* queue and player bar fully usable. Drag the right edge to resize.
  - **Fullscreen mode** — immersive view with the blurred album art as background.
- ⚡ **Prefetching** — lyrics for the next few songs in your queue (including *"Play next"* additions) are fetched ahead of time, so they appear instantly on song change.
- 💾 **Persistent cache** — lyrics of songs you've played are kept on disk (`chrome.storage.local`, LRU-capped at 300 entries ≈ under 2 MB), so replaying a song shows its lyrics instantly, even after restarting the app. No RAM concerns: lyrics are just a few KB of text each.
- 🎼 **YouTube Music fallback** — if LRCLIB doesn't have the song, the extension reads the lyrics YouTube Music itself offers in its *Lyrics* tab (unsynced). Only when neither source has them will you see a "not found" message.
- 🌐 **Localized UI** — English by default, Spanish included (follows your browser language).
- 🔒 **Private** — runs only on `music.youtube.com`, talks only to `lrclib.net`, collects nothing.

## Installation

1. Download this repository (**Code → Download ZIP**) and unzip it to a permanent folder (e.g. `C:\Extensions\ytmusic-big-lyrics`). Don't delete it afterwards — Chrome loads the extension from there.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. If you use the YouTube Music **desktop app** (Chrome PWA): close it completely and open it again. The extension works inside it automatically.

## Usage

- Play a song and click the red floating button (bottom-right).
- Click any lyric line to jump to that part.
- Scroll to explore; use **⤓ Back to the current line** to resume auto-scroll.
- Use the button next to ✕ to switch between **panel** and **fullscreen** modes.
- In panel mode, drag the handle on the right edge to resize the panel. Open the player page (click the album art in the bottom bar) to see the *Up next* queue beside the lyrics.
- Press **Esc** or ✕ to close.

## How it works

| File | Role |
| --- | --- |
| `content.js` | Detects the playing song (player bar + video id), renders the UI, handles auto-scroll/manual-scroll, click-to-seek, prefetching and the session cache. |
| `background.js` | Service worker. Queries the LRCLIB API (exact match → track/artist search → free-text search) and maintains the persistent on-disk lyrics cache. |
| `page-bridge.js` | Runs in the page's main world. Bridges to YouTube's official player API (`seekTo`, exact current time, video id) and to YouTube Music's internal endpoints to read its native *Lyrics* tab. |
| `styles.css` | Panel and fullscreen styling. |
| `_locales/` | UI strings (English default, Spanish included). |

Song changes are detected primarily by **video id** — which changes on every track, including brand-new queues — with the player-bar title/artist as a secondary signal. Seeking uses the player's own `seekTo()` (the same mechanism as the progress bar), never raw `<video>.currentTime` manipulation, which avoids desyncs.

## Limitations

- Lyrics availability depends on LRCLIB and on YouTube Music's own catalog; very new or niche songs may have no lyrics anywhere.
- YouTube Music is a fast-moving app; if a redesign changes its internal DOM, selectors may need updating. Issues and PRs welcome.

## Credits

- Lyrics provided by [LRCLIB](https://lrclib.net) — please be kind to their free service.
- Not affiliated with YouTube or Google.

## License

[MIT](LICENSE)
