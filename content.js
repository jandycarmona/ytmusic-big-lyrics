// content.js — Big Lyrics for YouTube Music
// Detects the playing song, fetches synced lyrics (LRCLIB, with YouTube
// Music's own lyrics as a fallback) and renders them in a Spotify-style
// panel: big text, highlighted current line, auto-scroll, click-to-seek.

(() => {
  'use strict';

  // Flip to true to trace lyrics fetching, cache hits/misses and the
  // duration used vs. the real track length in the page console.
  const DEBUG = false;

  // If a cached synced master's own duration differs from the real track
  // length by more than this (seconds), we assume a wrong master slipped in
  // (e.g. a prefetch that ran without a reliable duration) and refetch with
  // the correct duration. Loose enough not to churn on legitimately-close
  // masters; tight enough to catch the constant-offset bug.
  const DURATION_TOLERANCE = 5;

  // ---------- i18n ----------

  const FALLBACK_STRINGS = {
    fabTitle: 'Show lyrics (Spotify-style)',
    closeTitle: 'Close (Esc)',
    modeFullscreenTitle: 'Fullscreen',
    modePanelTitle: 'Panel mode (keeps the queue visible)',
    resizeTitle: 'Drag to resize the panel',
    searching: 'Looking for lyrics…',
    notFound: 'No lyrics found for this song 😕',
    plainNote: "Unsynced lyrics (they won't highlight with the music)",
    nativeNote: 'Lyrics from YouTube Music (unsynced)',
    hint: 'Click a line to jump to that part · Esc to close',
    backToCurrent: 'Back to the current line',
  };

  function t(key) {
    try {
      return chrome.i18n.getMessage(key) || FALLBACK_STRINGS[key] || key;
    } catch {
      return FALLBACK_STRINGS[key] || key;
    }
  }

  // ---------- State ----------

  const state = {
    track: '',
    artist: '',
    videoId: null,
    lines: [],           // [{ t: seconds, text }]
    plain: '',           // unsynced lyrics fallback
    plainSource: '',     // 'lrclib' | 'native'
    status: 'idle',      // idle | loading | synced | plain | notfound
    open: false,
    activeIdx: -1,
    stale: true,         // song changed; lyrics must be fetched again
    instantCenter: false,
    userScrolling: false, // the user is exploring; pause auto-scroll
    mode: localStorage.getItem('ytml-mode') || 'panel', // panel | fullscreen
  };

  const ICON_EXPAND =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
  const ICON_PANEL =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 5v14h18V5H3zm2 2h9v10H5V7zm11 10V7h5v10h-5z"/></svg>';

  // ---------- Utilities ----------

  const $ = (sel, root = document) => root.querySelector(sel);

  // Trusted Types: YouTube Music's main world requires TrustedHTML for
  // innerHTML. Content scripts normally run exempt, but if the page's policy
  // ever applies here, wrap our own static markup in a pass-through policy
  // instead of letting the whole UI fail to build.
  let ttPolicy = null;
  function toHTML(html) {
    if (!window.trustedTypes) return html;
    try {
      if (!ttPolicy) {
        ttPolicy = window.trustedTypes.createPolicy('ytml', {
          createHTML: (s) => s, // only ever fed our own constant templates
        });
      }
      return ttPolicy.createHTML(html);
    } catch {
      return html;
    }
  }
  function setHTML(el, html) {
    try {
      el.innerHTML = html;
    } catch {
      el.innerHTML = toHTML(html);
    }
  }

  // YT Music can leave more than one <video> in the page while switching
  // songs. Always pick the one that is actually playing, never a stale one.
  function getVideo() {
    const vids = [...document.querySelectorAll('video')];
    if (!vids.length) return null;
    const playing = vids.find((v) => !v.paused && !v.ended && v.readyState >= 2);
    if (playing) return playing;
    const withSource = vids.find((v) => (v.src || v.srcObject) && !v.ended);
    return withSource || vids[vids.length - 1];
  }

  function cleanTitle(title) {
    return title
      .replace(/\s*[\(\[][^\)\]]*(official|oficial|video|lyric|letra|audio|visualizer|mv|hd|4k)[^\)\]]*[\)\]]/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ---------- Now-playing bar ----------
  // YouTube Music has shipped two now-playing bars:
  //   - Legacy (until ~Oct 2026): <ytmusic-player-bar> with .title / .byline
  //     and img.image.
  //   - "Wiz" mini player (Oct 2026): <ytmusic-miniplayer> containing
  //     <ytmusic-track-info> with .ytmusicTrackInfoTitle (full title in its
  //     `title` attribute), .ytmusicTrackInfoByline ("Artist • Album • Year"
  //     for songs, "Artist • N views • N likes" for videos) and
  //     img.ytmusicTrackInfoThumbnail.
  // Rollouts are A/B tested, so both are supported. When neither yields a
  // title, the official player API (via page-bridge.js) is the last resort.

  function getBarEl() {
    return $('ytmusic-miniplayer') || $('ytmusic-player-bar');
  }

  function readWizTrackInfo() {
    const info = $('ytmusic-track-info');
    if (!info) return null;
    const titleEl = info.querySelector('.ytmusicTrackInfoTitle');
    const title = (
      titleEl?.getAttribute('title') ||
      titleEl?.textContent ||
      ''
    ).trim();
    if (!title) return null; // blank while an ad plays
    const bylineEl = info.querySelector('.ytmusicTrackInfoByline');
    const links = [...(bylineEl?.querySelectorAll('a') || [])].map((a) =>
      a.textContent.trim()
    );
    const byline = (bylineEl?.textContent || '').trim();
    const artist = links[0] || byline.split('•')[0].trim();
    // Songs link both artist and album; videos only link the artist.
    const album = links.length >= 2 ? links[links.length - 1] : '';
    return { title, artist, album };
  }

  function readLegacyPlayerBar() {
    const bar = $('ytmusic-player-bar');
    if (!bar) return null;
    const title = bar.querySelector('.title')?.textContent?.trim();
    if (!title) return null;
    const byline = bar.querySelector('.byline')?.textContent?.trim() || '';
    const parts = byline.split('•').map((s) => s.trim());
    // Legacy byline for songs: "Artist • Album • Year".
    const album = parts.length >= 3 && /^\d{4}$/.test(parts[2]) ? parts[1] : '';
    return { title, artist: parts[0] || '', album };
  }

  function readFromPlayer() {
    // Only trust it when fresh and not during an ad.
    if (!playerTime.title || playerTime.ad) return null;
    if (performance.now() - playerTime.at > 2000) return null;
    const artist = (playerTime.author || '').replace(/\s+-\s+Topic$/i, '').trim();
    return { title: playerTime.title.trim(), artist, album: '' };
  }

  function getNowPlaying() {
    return readWizTrackInfo() || readLegacyPlayerBar() || readFromPlayer();
  }

  function getArtworkUrl() {
    const img =
      $('ytmusic-track-info img.ytmusicTrackInfoThumbnail') ||
      $('ytmusic-player-bar img.image');
    if (!img || !img.src) return '';
    return img.src.replace(/w\d+-h\d+/, 'w544-h544'); // request a big cover
  }

  // The bar's height changed with the redesign (64–72 px depending on the
  // window width), so panel mode and the floating button follow the real
  // value instead of a hard-coded one.
  function syncBarHeight() {
    const bar = getBarEl();
    const h = bar ? Math.round(bar.getBoundingClientRect().height) : 0;
    const val = `${h > 0 ? h : 72}px`;
    const root = document.documentElement;
    if (root.style.getPropertyValue('--ytml-bar-h') !== val) {
      root.style.setProperty('--ytml-bar-h', val);
    }
  }

  function parseLRC(lrc) {
    const lines = [];
    for (const raw of lrc.split('\n')) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
      if (!stamps.length) continue;
      const text = raw.replace(/\[[^\]]*\]/g, '').trim();
      for (const m of stamps) {
        const frac = m[3] ? parseFloat('0.' + m[3]) : 0;
        const time = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac;
        lines.push({ t: time, text });
      }
    }
    lines.sort((a, b) => a.t - b.t);
    return lines;
  }

  // ---------- Player bridge (page-bridge.js, MAIN world) ----------
  // YouTube's official player (#movie_player) gives exact time, duration and
  // video id for the current track; the <video> element can lag behind.

  const playerTime = {
    t: null,
    d: null,
    v: null,
    title: null,
    author: null,
    ad: false,
    at: 0,
  };
  let nativeReq = null; // pending native-lyrics request { key, cb, timer }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.type !== 'string') return;

    if (e.data.type === 'ytml-time-resp') {
      playerTime.t = e.data.t;
      playerTime.d = e.data.d;
      playerTime.v = e.data.v || null;
      playerTime.title = e.data.title || null;
      playerTime.author = e.data.author || null;
      playerTime.ad = !!e.data.ad;
      playerTime.at = performance.now();
    } else if (e.data.type === 'ytml-seek-fallback') {
      const v = getVideo();
      if (v) {
        v.currentTime = e.data.t;
        if (v.paused) v.play();
      }
    } else if (e.data.type === 'ytml-native-lyrics-resp') {
      if (nativeReq && nativeReq.key === e.data.key) {
        clearTimeout(nativeReq.timer);
        const cb = nativeReq.cb;
        nativeReq = null;
        cb(e.data.lyrics || null);
      }
    }
  });

  function requestPlayerTime() {
    window.postMessage({ type: 'ytml-time' }, '*');
  }

  function getCurrentTime() {
    // Prefer the official player's time when fresh (< 1 s); otherwise fall
    // back to the active <video> element.
    if (playerTime.t != null && performance.now() - playerTime.at < 1000) {
      return playerTime.t;
    }
    const v = getVideo();
    return v ? v.currentTime : null;
  }

  function getDuration() {
    // Trust the official player's duration only when it is fresh AND belongs
    // to the track we currently consider active. Right after a song change
    // the last time-resp may still carry the PREVIOUS track's duration (it is
    // reported together with its video id), which — sent to LRCLIB — would
    // select a mismatched master. Since duration and video id arrive in the
    // same message, matching ids guarantees the duration is the current one.
    if (
      playerTime.d &&
      isFinite(playerTime.d) &&
      performance.now() - playerTime.at < 5000 &&
      (!state.videoId || playerTime.v === state.videoId)
    ) {
      return playerTime.d;
    }
    const v = getVideo();
    return v && isFinite(v.duration) ? v.duration : null;
  }

  function seekTo(time) {
    window.postMessage({ type: 'ytml-seek', t: time }, '*');
    playerTime.t = time;
    playerTime.at = performance.now();
    // Clicking a line means "take me there": resume auto-scroll.
    state.userScrolling = false;
    updateResumeBtn();
    state.activeIdx = -2; // force an immediate highlight refresh
  }

  function requestNativeLyrics(key, cb) {
    if (nativeReq) clearTimeout(nativeReq.timer);
    nativeReq = {
      key,
      cb,
      timer: setTimeout(() => {
        if (nativeReq && nativeReq.key === key) {
          nativeReq = null;
          cb(null);
        }
      }, 6000),
    };
    window.postMessage({ type: 'ytml-native-lyrics', key }, '*');
  }

  // ---------- Lyrics cache & prefetching ----------
  // Session cache (tiny: lyrics are a few KB of text each). The background
  // service worker also keeps a persistent cache on disk, so previously
  // played songs load instantly even after restarting the app.

  const sessionCache = new Map(); // "title|artist" -> data | null
  const SESSION_CACHE_MAX = 60;

  // Keys already re-validated against the real duration this session, so a
  // song whose best available master is legitimately off-length is refetched
  // at most once instead of on every replay.
  const revalidatedKeys = new Set();

  // Lookups currently waiting on the background worker: key -> [callbacks].
  const inflight = new Map();

  function cacheKey(track, artist) {
    return `${track}|${artist}`.toLowerCase();
  }

  function sessionCachePut(key, data) {
    sessionCache.set(key, data);
    if (sessionCache.size > SESSION_CACHE_MAX) {
      sessionCache.delete(sessionCache.keys().next().value);
    }
  }

  function requestLyrics(track, artist, duration, cb, opts) {
    const force = !!(opts && opts.force);
    const key = cacheKey(track, artist);
    if (!force && sessionCache.has(key) && sessionCache.get(key) !== null) {
      if (DEBUG) console.log('[ytml] requestLyrics session HIT', key);
      if (cb) cb(sessionCache.get(key));
      return;
    }
    if (DEBUG) {
      console.log(
        '[ytml] requestLyrics %s %s dur=%s',
        force ? 'FORCE' : 'MISS',
        key,
        duration
      );
    }
    // Overlapping prefetch passes (on song change, at boot, every 15 s) can
    // ask for the same song before the first answer arrives. Join the
    // request already in flight instead of hitting LRCLIB again.
    if (!force && inflight.has(key)) {
      if (cb) inflight.get(key).push(cb);
      return;
    }
    if (!force) inflight.set(key, cb ? [cb] : []);
    chrome.runtime.sendMessage(
      {
        type: 'getLyrics',
        track: cleanTitle(track),
        artist,
        album: (opts && opts.album) || undefined,
        duration,
        forceRefresh: force,
      },
      (resp) => {
        const data =
          !chrome.runtime.lastError && resp && resp.ok ? resp.data : null;
        sessionCachePut(key, data);
        if (force) {
          if (cb) cb(data);
          return;
        }
        const waiting = inflight.get(key) || [];
        inflight.delete(key);
        for (const fn of waiting) fn(data);
      }
    );
  }

  function parseQueueItem(item) {
    const title = item.querySelector('.song-title')?.textContent?.trim();
    if (!title) return null;
    const artist = (item.querySelector('.byline')?.textContent || '')
      .split('•')[0]
      .trim();
    let duration = null;
    const durTxt = item.querySelector('.duration')?.textContent?.trim();
    if (durTxt && /^\d+:\d{2}$/.test(durTxt)) {
      const [m, s] = durTxt.split(':').map(Number);
      duration = m * 60 + s;
    }
    return { title, artist, duration };
  }

  function getUpcomingInQueue(limit) {
    const items = [...document.querySelectorAll('ytmusic-player-queue-item')];
    if (!items.length) return [];
    const idx = items.findIndex(
      (it) =>
        it.hasAttribute('selected') ||
        ['playing', 'paused'].includes(it.getAttribute('play-button-state'))
    );
    // If the selected item can't be identified, fall back to the first few
    // items so prefetching still works ("play next" additions included).
    const slice = items.slice(idx + 1, idx + 1 + limit);
    return slice.map(parseQueueItem).filter(Boolean);
  }

  function prefetchQueue() {
    const upcoming = getUpcomingInQueue(5);
    let delay = 0;
    for (const it of upcoming) {
      const key = cacheKey(it.title, it.artist);
      if (sessionCache.has(key) && sessionCache.get(key) !== null) continue;
      // Stagger requests to be polite with the free LRCLIB service.
      setTimeout(() => requestLyrics(it.title, it.artist, it.duration, null), delay);
      delay += 400;
    }
  }

  // ---------- UI ----------

  let overlay, linesEl, headerTitle, headerArtist, fab, statusEl, resumeBtn;

  function buildUI() {
    // Floating button
    fab = document.createElement('button');
    fab.id = 'ytml-fab';
    fab.title = t('fabTitle');
    setHTML(
      fab,
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>'
    );
    fab.addEventListener('click', toggleOverlay);
    document.body.appendChild(fab);

    // Lyrics panel
    overlay = document.createElement('div');
    overlay.id = 'ytml-overlay';
    overlay.hidden = true;
    setHTML(overlay, `
      <div id="ytml-bg"></div>
      <div id="ytml-scrim"></div>
      <header id="ytml-header">
        <div>
          <div id="ytml-song"></div>
          <div id="ytml-artist"></div>
        </div>
        <div id="ytml-header-btns">
          <button id="ytml-mode"></button>
          <button id="ytml-close" title="${t('closeTitle')}">✕</button>
        </div>
      </header>
      <div id="ytml-status" hidden></div>
      <main id="ytml-lines"></main>
      <button id="ytml-resume" hidden>⤓ ${t('backToCurrent')}</button>
      <div id="ytml-resize" title="${t('resizeTitle')}"></div>
      <footer id="ytml-hint">${t('hint')}</footer>
    `);
    document.body.appendChild(overlay);

    linesEl = $('#ytml-lines', overlay);
    headerTitle = $('#ytml-song', overlay);
    headerArtist = $('#ytml-artist', overlay);
    statusEl = $('#ytml-status', overlay);
    resumeBtn = $('#ytml-resume', overlay);

    $('#ytml-close', overlay).addEventListener('click', toggleOverlay);
    $('#ytml-mode', overlay).addEventListener('click', () => {
      state.mode = state.mode === 'panel' ? 'fullscreen' : 'panel';
      localStorage.setItem('ytml-mode', state.mode);
      applyMode();
      recenterActive(false);
    });
    applyMode();

    // Panel width: restore the saved value and allow drag-resizing.
    const savedW = parseInt(localStorage.getItem('ytml-width') || '', 10);
    if (savedW) overlay.style.setProperty('--ytml-width', `${savedW}px`);

    const resizer = $('#ytml-resize', overlay);
    let dragging = false;
    resizer.addEventListener('pointerdown', (e) => {
      if (state.mode !== 'panel') return;
      dragging = true;
      resizer.setPointerCapture(e.pointerId);
      overlay.classList.add('resizing');
      e.preventDefault();
    });
    resizer.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const w = Math.min(Math.max(e.clientX, 340), window.innerWidth * 0.92);
      overlay.style.setProperty('--ytml-width', `${Math.round(w)}px`);
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      overlay.classList.remove('resizing');
      const w = Math.round(overlay.getBoundingClientRect().width);
      localStorage.setItem('ytml-width', String(w));
      recenterActive(false);
    };
    resizer.addEventListener('pointerup', endDrag);
    resizer.addEventListener('pointercancel', endDrag);

    // Manual scrolling pauses auto-scroll (Spotify-style). The resume button
    // brings the view back to the current line and re-enables auto-scroll.
    const enterManualScroll = () => {
      if (!state.open || state.status !== 'synced') return;
      state.userScrolling = true;
      updateResumeBtn();
    };
    linesEl.addEventListener('wheel', enterManualScroll, { passive: true });
    linesEl.addEventListener('touchmove', enterManualScroll, { passive: true });
    linesEl.addEventListener('pointerdown', (e) => {
      // Direct interaction with the container (scrollbar drag or empty
      // space) counts as manual scrolling; clicking a line does not.
      if (e.target === linesEl) enterManualScroll();
    });
    resumeBtn.addEventListener('click', () => resumeAutoScroll(true));

    // Keep the active line centered after window resizes.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => recenterActive(false), 150);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) toggleOverlay();
    });
  }

  function applyMode() {
    overlay.classList.toggle('panel', state.mode === 'panel');
    const btn = $('#ytml-mode', overlay);
    if (btn) {
      setHTML(btn, state.mode === 'panel' ? ICON_EXPAND : ICON_PANEL);
      btn.title =
        state.mode === 'panel' ? t('modeFullscreenTitle') : t('modePanelTitle');
    }
    // Only lock page scrolling in fullscreen mode.
    document.documentElement.classList.toggle(
      'ytml-no-scroll',
      state.open && state.mode === 'fullscreen'
    );
  }

  function updateResumeBtn() {
    if (!resumeBtn) return;
    resumeBtn.hidden = !(
      state.userScrolling && state.open && state.status === 'synced'
    );
  }

  function resumeAutoScroll(smooth) {
    state.userScrolling = false;
    updateResumeBtn();
    recenterActive(smooth);
  }

  function recenterActive(smooth) {
    if (state.userScrolling) return;
    const active = linesEl && linesEl.querySelector('.ytml-line.active');
    if (active) centerLine(active, smooth);
  }

  // Centers a line by scrolling ONLY the lyrics container.
  // (scrollIntoView also scrolls ancestor containers, which used to push the
  // header — and its buttons — off screen.)
  function centerLine(el, smooth = true) {
    overlay.scrollTop = 0; // the panel itself must never scroll
    const top = el.offsetTop - linesEl.clientHeight / 2 + el.clientHeight / 2;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    linesEl.scrollTo({
      top: Math.max(0, top),
      behavior: smooth && !reduce ? 'smooth' : 'auto',
    });
  }

  function setStatus(msg) {
    if (!statusEl) return;
    if (msg) {
      statusEl.textContent = msg;
      statusEl.hidden = false;
      linesEl.replaceChildren();
    } else {
      statusEl.hidden = true;
    }
  }

  function renderLyrics() {
    headerTitle.textContent = state.track;
    headerArtist.textContent = state.artist;

    const art = getArtworkUrl();
    const bg = $('#ytml-bg', overlay);
    bg.style.backgroundImage = art ? `url("${art}")` : 'none';

    state.userScrolling = false;
    updateResumeBtn();

    if (state.status === 'loading') return setStatus(t('searching'));
    if (state.status === 'notfound') return setStatus(t('notFound'));

    setStatus('');
    linesEl.replaceChildren();
    linesEl.scrollTop = 0;

    if (state.status === 'plain') {
      const note = document.createElement('div');
      note.id = 'ytml-plain-note';
      note.textContent =
        state.plainSource === 'native' ? t('nativeNote') : t('plainNote');
      linesEl.appendChild(note);
      const p = document.createElement('div');
      p.id = 'ytml-plain';
      p.textContent = state.plain;
      linesEl.appendChild(p);
      return;
    }

    // Synced lyrics
    state.lines.forEach((line, i) => {
      const p = document.createElement('p');
      p.className = 'ytml-line';
      p.dataset.idx = i;
      p.textContent = line.text || '♪';
      p.addEventListener('click', () => seekTo(line.t));
      linesEl.appendChild(p);
    });
    state.activeIdx = -1;
    state.instantCenter = true; // first positioning is immediate
  }

  function updateActiveLine() {
    if (!state.open || state.status !== 'synced') return;
    requestPlayerTime();
    const now = getCurrentTime();
    if (now == null) return;
    const time = now + 0.25; // slight lead so highlighting feels natural

    let idx = -1;
    for (let i = 0; i < state.lines.length; i++) {
      if (state.lines[i].t <= time) idx = i;
      else break;
    }
    if (idx === state.activeIdx) return;

    const prev = linesEl.querySelector('.ytml-line.active');
    if (prev) prev.classList.remove('active');
    state.activeIdx = idx;

    if (idx >= 0) {
      const el = linesEl.querySelector(`.ytml-line[data-idx="${idx}"]`);
      if (el) {
        el.classList.add('active');
        // Highlighting always follows the song; scrolling only when the
        // user is not exploring the lyrics manually.
        if (!state.userScrolling) {
          centerLine(el, !state.instantCenter);
          state.instantCenter = false;
        }
      }
    } else if (!state.userScrolling) {
      // Song restarted (e.g. repeat-one): go back to the top.
      linesEl.scrollTo({ top: 0, behavior: 'auto' });
    }
  }

  function toggleOverlay() {
    state.open = !state.open;
    overlay.hidden = !state.open;
    applyMode();
    if (state.open && state.stale) fetchLyrics();
    else if (state.open) renderLyrics();
  }

  // ---------- Data flow ----------

  function currentKey() {
    return `${state.track}|${state.artist}`;
  }

  function fetchLyrics() {
    const np = getNowPlaying();
    if (!np || !np.title) {
      if (playerTime.ad) {
        // An ad is playing: the bar is blank for now. Keep "searching" and
        // stay stale; the watch loop refetches as soon as the title shows.
        state.status = 'loading';
        state.stale = true;
      } else {
        state.status = 'notfound';
      }
      if (state.open) renderLyrics();
      return;
    }
    state.track = np.title;
    state.artist = np.artist;
    state.status = 'loading';
    state.stale = false;
    state.lines = [];
    state.plain = '';
    state.plainSource = '';
    state.activeIdx = -1;
    if (state.open) renderLyrics();

    const reqKey = currentKey();
    const dedupKey = cacheKey(np.title, np.artist);
    // Reliable, current-track duration (getDuration() is now video-id-guarded).
    const reliableDur = getDuration();
    if (DEBUG) console.log('[ytml] fetchLyrics "%s" durSent=%s', np.title, reliableDur);

    const onData = (data) => {
      if (currentKey() !== reqKey) return; // stale response: song changed

      // Re-validate synced lyrics against the real track length. A prefetch
      // that ran with a missing/unreliable queue duration can cache a wrong
      // master (correct words, another master's timestamps) → a constant
      // offset. If the cached master's own duration is far from the real one,
      // refetch ONCE forcing a fresh, duration-aware lookup that overwrites
      // both the session and the persistent cache.
      if (
        !revalidatedKeys.has(dedupKey) &&
        data &&
        data.syncedLyrics &&
        reliableDur &&
        typeof data.duration === 'number' &&
        Math.abs(data.duration - reliableDur) > DURATION_TOLERANCE
      ) {
        revalidatedKeys.add(dedupKey);
        if (DEBUG) {
          console.log(
            '[ytml] duration mismatch: master=%s real=%s -> refetch',
            data.duration,
            reliableDur
          );
        }
        requestLyrics(np.title, np.artist, reliableDur, onData, {
          force: true,
          album: np.album,
        });
        return;
      }

      if (data && data.syncedLyrics) {
        state.lines = parseLRC(data.syncedLyrics);
        state.status = state.lines.length ? 'synced' : 'notfound';
        if (DEBUG) {
          console.log(
            '[ytml] synced OK lines=%d masterDur=%s real=%s',
            state.lines.length,
            data.duration,
            reliableDur
          );
        }
      } else if (data && data.plainLyrics) {
        state.plain = data.plainLyrics;
        state.plainSource = data.native ? 'native' : 'lrclib';
        state.status = 'plain';
      } else {
        // LRCLIB has nothing: fall back to YouTube Music's own lyrics tab.
        requestNativeLyrics(reqKey, (text) => {
          if (currentKey() !== reqKey) return;
          if (text) {
            state.plain = text;
            state.plainSource = 'native';
            state.status = 'plain';
            sessionCachePut(cacheKey(np.title, np.artist), {
              plainLyrics: text,
              native: true,
            });
            chrome.runtime.sendMessage({
              type: 'storeNativeLyrics',
              track: cleanTitle(np.title),
              artist: np.artist,
              lyrics: text,
            });
          } else {
            state.status = 'notfound';
          }
          if (state.open) renderLyrics();
        });
        return; // keep "loading" until the fallback resolves
      }
      if (state.open) renderLyrics();
    };

    requestLyrics(np.title, np.artist, reliableDur, onData, { album: np.album });
  }

  // ---------- Watch loops ----------

  function watchSongChanges() {
    let lastVideoId = null;
    let fetchTimer = null;

    setInterval(() => {
      // Keep time/duration/videoId fresh even while the panel is closed.
      requestPlayerTime();

      const np = getNowPlaying();
      const vid = playerTime.v || null;

      // A song change is detected by video id (bulletproof: it changes on
      // every track, including brand-new queues) or by title/artist (covers
      // the rare case where the player API lags behind the UI).
      const byId = vid && vid !== lastVideoId;
      const byTitle =
        np && np.title && `${np.title}|${np.artist}` !== currentKey();
      // The panel was left "searching" because an ad blanked the bar; the
      // title is back (possibly the same song, e.g. on repeat): fetch now.
      const afterAd =
        state.open && state.stale && state.status === 'loading' &&
        np && np.title && !playerTime.ad;

      syncBarHeight();

      if (byId || byTitle || afterAd) {
        // Register the current video id so getDuration() only trusts a
        // player duration tagged with this same id (avoids the previous
        // track's duration leaking into the fetch right after a change).
        if (vid) {
          lastVideoId = vid;
          state.videoId = vid;
        }
        state.stale = true;
        state.userScrolling = false;
        updateResumeBtn();

        // Give the player bar ~half a second to finish updating its title
        // and artist before reading them; re-checks are debounced.
        clearTimeout(fetchTimer);
        fetchTimer = setTimeout(() => {
          if (state.open) fetchLyrics();
          else {
            const now = getNowPlaying();
            if (now && now.title) {
              state.track = now.title;
              state.artist = now.artist;
            }
          }
        }, 500);

        // Prefetch the upcoming queue once it settles.
        setTimeout(prefetchQueue, 3000);
      }
    }, 700);

    setInterval(updateActiveLine, 200);

    // Periodic prefetch: covers app start, queue reordering and songs added
    // via "Play next". It never repeats work — cached songs are skipped.
    setTimeout(prefetchQueue, 4000);
    setInterval(prefetchQueue, 15000);
  }

  // ---------- Boot ----------

  function init() {
    if ($('#ytml-fab')) return;
    syncBarHeight();
    buildUI();
    watchSongChanges();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
