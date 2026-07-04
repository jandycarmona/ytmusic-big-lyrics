// page-bridge.js — runs in the page's context (world: MAIN).
// Exposes YouTube's official player API (#movie_player) and YouTube Music's
// internal network layer, neither of which is reachable from the isolated
// content-script world.
//
// Message protocol with content.js (window.postMessage):
//   ytml-seek          { t }        -> seek to t seconds of the CURRENT track
//   ytml-time          {}           -> replies ytml-time-resp { t, d, v }
//                                      (current time, duration, video id)
//   ytml-native-lyrics { key }      -> replies ytml-native-lyrics-resp
//                                      { key, lyrics } with the lyrics from
//                                      YouTube Music's own "Lyrics" tab
//                                      (null when unavailable)

(() => {
  'use strict';

  function getPlayer() {
    const p = document.querySelector('#movie_player');
    return p && typeof p.getCurrentTime === 'function' ? p : null;
  }

  // Fetches the lyrics YouTube Music itself shows in its "Lyrics" tab, using
  // the app's own network manager (same internal API the tab uses):
  //   /next   -> watch-next data, contains the lyrics tab's browseId (MPLYt…)
  //   /browse -> the actual lyrics text
  async function fetchNativeLyrics() {
    try {
      const player = getPlayer();
      const videoId = player?.getVideoData?.().video_id;
      if (!videoId) return null;

      const app = document.querySelector('ytmusic-app');
      const nm = app && app.networkManager;
      if (!nm || typeof nm.fetch !== 'function') return null;

      const next = await nm.fetch('/next', { videoId });
      const tabs =
        next?.contents?.singleColumnMusicWatchNextResultsRenderer
          ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
      const browseId = tabs
        .map((t) => t?.tabRenderer?.endpoint?.browseEndpoint?.browseId)
        .find((id) => typeof id === 'string' && id.startsWith('MPLYt'));
      if (!browseId) return null;

      const browse = await nm.fetch('/browse', { browseId });
      const runs =
        browse?.contents?.sectionListRenderer?.contents?.[0]
          ?.musicDescriptionShelfRenderer?.description?.runs;
      if (!runs || !runs.length) return null;

      const text = runs.map((r) => r.text || '').join('').trim();
      return text || null;
    } catch {
      return null;
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.type !== 'string') return;

    if (e.data.type === 'ytml-seek') {
      const p = getPlayer();
      if (p && typeof p.seekTo === 'function') {
        p.seekTo(e.data.t, true);
        if (typeof p.playVideo === 'function') p.playVideo();
      } else {
        // Tell the content script to fall back to the HTML5 <video> element.
        window.postMessage({ type: 'ytml-seek-fallback', t: e.data.t }, '*');
      }
      return;
    }

    if (e.data.type === 'ytml-time') {
      const p = getPlayer();
      if (p) {
        window.postMessage(
          {
            type: 'ytml-time-resp',
            t: p.getCurrentTime(),
            d: typeof p.getDuration === 'function' ? p.getDuration() : null,
            v: p.getVideoData ? p.getVideoData().video_id : null,
          },
          '*'
        );
      }
      return;
    }

    if (e.data.type === 'ytml-native-lyrics') {
      const key = e.data.key;
      fetchNativeLyrics().then((lyrics) => {
        window.postMessage({ type: 'ytml-native-lyrics-resp', key, lyrics }, '*');
      });
    }
  });
})();
