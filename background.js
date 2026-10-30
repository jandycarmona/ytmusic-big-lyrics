// background.js
// Fetches lyrics from LRCLIB (https://lrclib.net) — a free, open API, no key
// required — and keeps a persistent cache in chrome.storage.local so songs
// you've already played load instantly, even after restarting the app.
//
// Notes on memory: lyrics are plain text (a few KB per song). The cache is
// capped at MAX_CACHE_ENTRIES with least-recently-used eviction, so it stays
// tiny (well under 2 MB) and lives on disk, not in RAM.

const API = 'https://lrclib.net/api';
const HEADERS = { 'Lrclib-Client': 'Big-Lyrics-for-YouTube-Music v1.1.0' };

const CACHE_PREFIX = 'lyr:';
const MAX_CACHE_ENTRIES = 300;

// Flip to true to trace cache hits/misses and master selection in the
// service-worker console (chrome://extensions -> service worker).
const DEBUG = false;

// ---------- Persistent cache ----------

function cacheStorageKey(track, artist) {
  return CACHE_PREFIX + `${track}|${artist}`.toLowerCase().slice(0, 200);
}

async function cacheGet(key) {
  const obj = await chrome.storage.local.get(key);
  const entry = obj[key];
  if (!entry) return null;
  // LRU touch: refresh the timestamp so frequently played songs stay cached.
  chrome.storage.local.set({ [key]: { ...entry, at: Date.now() } });
  return entry.data;
}

async function cachePut(key, data) {
  await chrome.storage.local.set({ [key]: { data, at: Date.now() } });
  pruneCache();
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith(CACHE_PREFIX));
  if (entries.length <= MAX_CACHE_ENTRIES) return;
  entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  const toRemove = entries
    .slice(0, entries.length - MAX_CACHE_ENTRIES)
    .map(([k]) => k);
  await chrome.storage.local.remove(toRemove);
}

// ---------- LRCLIB lookup ----------

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  return res.json();
}

function pickBest(results, durationSec) {
  if (!Array.isArray(results) || results.length === 0) return null;
  // Prefer synced lyrics whose duration is close to the playing track.
  const scored = results
    .filter((r) => r.syncedLyrics || r.plainLyrics)
    .map((r) => {
      let score = 0;
      if (r.syncedLyrics) score += 100;
      if (durationSec && r.duration) {
        const diff = Math.abs(r.duration - durationSec);
        if (diff <= 3) score += 50;
        else if (diff <= 10) score += 20;
        else score -= diff;
      }
      return { r, score };
    })
    .sort((a, b) => b.score - a.score);
  if (DEBUG && scored.length) {
    console.log(
      '[ytml-bg] pickBest dur=%s ->',
      durationSec,
      scored.slice(0, 5).map((s) => ({
        id: s.r.id,
        name: s.r.trackName,
        dur: s.r.duration,
        synced: !!s.r.syncedLyrics,
        score: s.score,
      }))
    );
  }
  return scored.length ? scored[0].r : null;
}

async function lookupLyrics({ track, artist, album, duration }) {
  // 1) Exact match
  const exactParams = new URLSearchParams({
    track_name: track,
    artist_name: artist,
  });
  if (album) exactParams.set('album_name', album);
  if (duration) exactParams.set('duration', String(Math.round(duration)));

  let data = await fetchJson(`${API}/get?${exactParams}`);
  if (data && (data.syncedLyrics || data.plainLyrics)) return data;

  // 2) Track + artist search
  data = await fetchJson(
    `${API}/search?${new URLSearchParams({ track_name: track, artist_name: artist })}`
  );
  let best = pickBest(data, duration);
  if (best) return best;

  // 3) Free-text search (helps with "feat." and formatting differences)
  data = await fetchJson(
    `${API}/search?${new URLSearchParams({ q: `${track} ${artist}` })}`
  );
  best = pickBest(data, duration);
  if (best) return best;

  return null;
}

async function getLyrics(msg) {
  const key = cacheStorageKey(msg.track, msg.artist);

  // forceRefresh: the content script detected that the cached master's
  // duration disagrees with the real track length (a mismatched master was
  // cached by a prefetch that ran without a reliable duration). Bypass the
  // cache and overwrite it with a fresh, duration-aware lookup.
  if (!msg.forceRefresh) {
    const cached = await cacheGet(key);
    if (cached) {
      if (DEBUG) console.log('[ytml-bg] cache HIT', key, 'dur=', cached.duration);
      return cached;
    }
  }
  if (DEBUG) {
    console.log(
      '[ytml-bg] cache %s %s dur=%s',
      msg.forceRefresh ? 'BYPASS' : 'MISS',
      key,
      msg.duration
    );
  }

  const data = await lookupLyrics(msg);
  // Only successful results are persisted: a song missing today may be
  // added to LRCLIB tomorrow, so misses are never cached to disk.
  if (data && (data.syncedLyrics || data.plainLyrics)) {
    const slim = {
      syncedLyrics: data.syncedLyrics || null,
      plainLyrics: data.plainLyrics || null,
      // The chosen master's own duration. Stored so the content script can
      // re-validate it against the real track length at playback time and
      // refetch if a wrong master slipped through (see fetchLyrics).
      duration: typeof data.duration === 'number' ? data.duration : null,
    };
    if (DEBUG) {
      console.log(
        '[ytml-bg] picked master dur=%s synced=%s',
        slim.duration,
        !!slim.syncedLyrics
      );
    }
    await cachePut(key, slim);
    return slim;
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'getLyrics') {
    getLyrics(msg)
      .then((data) => sendResponse({ ok: !!data, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async response
  }
  if (msg && msg.type === 'storeNativeLyrics') {
    // Persist lyrics recovered from YouTube Music's own Lyrics tab so they
    // are also instant next time.
    const key = cacheStorageKey(msg.track, msg.artist);
    cachePut(key, { syncedLyrics: null, plainLyrics: msg.lyrics, native: true })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
