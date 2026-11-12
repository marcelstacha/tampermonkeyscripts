// ==UserScript==
// @name         Spotify Last.fm integration
// @namespace    http://tampermonkey.net/
// @version      2026-11-11
// @description  try to take over the world!
// @author       You
// @match        https://open.spotify.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=spotify.com
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // CONFIG - Hier deine Daten eintragen
    const LASTFM_USER = '';
    const LASTFM_API_KEY = '';
 const CACHE_TTL = 30 * 60 * 1000; // 30 Minuten Cache für Top-Listen
const DEFAULT_COVER_SVG = 'data:image/svg+xml,' + encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" fill="none">
          <path fill="#FFFFFF" fill-rule="evenodd" d="
              M 32 0 H 224 A 32 32 0 0 1 256 32 V 224 A 32 32 0 0 1 224 256 H 32 A 32 32 0 0 1 0 224 V 32 A 32 32 0 0 1 32 0 Z
              M 42 128 A 86 86 0 1 0 214 128 A 86 86 0 1 0 42 128 Z
              M 63 128 A 65 65 0 1 0 193 128 A 65 65 0 1 0 63 128 Z
              M 68 128 A 60 60 0 1 0 188 128 A 60 60 0 1 0 68 128 Z
              M 94 128 A 34 34 0 1 0 162 128 A 34 34 0 1 0 94 128 Z
              M 118 128 A 10 10 0 1 0 138 128 A 10 10 0 1 0 118 128 Z
            " />
        </svg>
    `.trim());

    const style = document.createElement('style');
    style.textContent = `
        .lastfm-view-2row { display: flex; flex-direction: column; gap: 5px; width: 100%; }
        .lastfm-view-3row { display: none; width: 100%; }

        /* --- Ticker Animation (Smart) --- */
        @keyframes lastfm-marquee {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
        }
        .lastfm-ticker-container {
            flex-grow: 1;
            overflow: hidden;
            white-space: nowrap;
        }
        .lastfm-ticker-content {
            display: inline-block;
            white-space: nowrap;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis; /* Kürzt mit ..., wenn nicht gescrollt wird */
        }
        /* Diese Klassen werden per JS NUR angehängt, wenn der Text zu breit ist */
        .lastfm-ticker-content.is-scrolling {
            max-width: none;
            overflow: visible;
            animation: lastfm-marquee 12s linear infinite;
        }
        .lastfm-ticker-content.is-scrolling:hover {
            animation-play-state: paused;
        }
        .lastfm-ticker-container.is-scrolling-mask {
            mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);
            -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);
        }

        @media (max-width: 2319px) {
            #lastfm-spotify-badge {
                right: unset !important;
                top: -66% !important;
                width: 416px !important;
            }
            .lastfm-view-2row { display: none !important; }
            .lastfm-view-3row { display: flex !important; flex-direction: column; gap: 5px; }
        }
    `;
    document.head.appendChild(style);

    let initialTrackKey = '';
    let initialTrackCapturedAt = 0;
    let playingPosSnapshot = '';
    let lastTrackKey = '';
    let hasStartedPlaying = false;
    let trackChangeTimer = null;

    const artistCache = {
        top30d: { data: null, timestamp: 0 },
        top90d: { data: null, timestamp: 0 },
        top12m: { data: null, timestamp: 0 },
        topOverall: { data: null, timestamp: 0 }
    };

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getSpotifyCoverUrl() {
        const img = document.querySelector('[data-testid="cover-art-image"]')
                 || document.querySelector('#main img[data-testid="cover-art-image"]')
                 || document.querySelector('footer img');
        return img ? img.src : null;
    }

    function getSpotifyCurrentTrackKey() {
        let artist = '';
        let title = '';

        if (navigator.mediaSession && navigator.mediaSession.metadata) {
            title = navigator.mediaSession.metadata.title || '';
            artist = navigator.mediaSession.metadata.artist || '';
        }

        if (!title || !artist) {
            const titleEl = document.querySelector('[data-testid="context-item-info-title"]')
                         || document.querySelector('[data-testid="now-playing-widget"] [data-testid="track-info-name"]');
            const artistEl = document.querySelector('[data-testid="context-item-info-artist"]')
                          || document.querySelector('[data-testid="now-playing-widget"] [data-testid="track-info-artists"]');

            if (titleEl) title = titleEl.textContent.trim();
            if (artistEl) artist = artistEl.textContent.trim();
        }

        if (!artist && !title) return '';
        return `${artist.toLowerCase()}:::${title.toLowerCase()}`;
    }

    function getPlaybackPosition() {
        const posEl = document.querySelector('[data-testid="playback-position"]');
        return posEl ? posEl.textContent.trim() : '';
    }

    function isSpotifyPlaying() {
        const playPauseBtn = document.querySelector('[data-testid="control-button-playpause"]');
        if (playPauseBtn) {
            const label = playPauseBtn.getAttribute('aria-label') || '';
            if (/pause|pausieren|anhalten/i.test(label)) {
                return true;
            }
            if (/play|abspielen|wiedergeben/i.test(label)) {
                return false;
            }
        }
        return Boolean(navigator.mediaSession && navigator.mediaSession.playbackState === 'playing');
    }

    function checkTrackChange() {
        const newTrackKey = getSpotifyCurrentTrackKey();
        const playing = isSpotifyPlaying();

        // Solange nach dem Neuladen noch nichts wirklich läuft:
        if (!hasStartedPlaying) {
            // Den von Spotify beim Reload wiederhergestellten Track merken
            if (newTrackKey && !initialTrackKey) {
                initialTrackKey = newTrackKey;
                initialTrackCapturedAt = Date.now();
            }

            if (!playing) {
                playingPosSnapshot = '';
                return;
            }

            const currentPos = getPlaybackPosition();
            if (!playingPosSnapshot && currentPos) {
                playingPosSnapshot = currentPos;
            }

            // Nur freischalten, wenn die Abspielzeit real voranschreitet ODER nach dem Reload ein neuer Track gewählt wurde
            const timeHasProgressed = Boolean(currentPos && playingPosSnapshot && currentPos !== playingPosSnapshot);
            const userSwitchedTrack = Boolean(
                newTrackKey &&
                initialTrackKey &&
                newTrackKey !== initialTrackKey &&
                (Date.now() - initialTrackCapturedAt > 2000)
            );

            if (!timeHasProgressed && !userSwitchedTrack) {
                return;
            }

            // Wiedergabe läuft nachweislich -> echtes Cover & normale Track-Change-Logik aktivieren
            hasStartedPlaying = true;
            lastTrackKey = newTrackKey;

            if (trackChangeTimer) clearTimeout(trackChangeTimer);
            trackChangeTimer = setTimeout(() => {
                updateBadge();
            }, 1500);
            return;
        }

        // Normales Verhalten nach dem ersten Abspielen
        if (newTrackKey && newTrackKey !== lastTrackKey) {
            lastTrackKey = newTrackKey;

            if (trackChangeTimer) clearTimeout(trackChangeTimer);
            trackChangeTimer = setTimeout(() => {
                updateBadge();
            }, 1500);
        }
    }

    async function getTopArtistsMap(period) {
        let cacheKey = 'topOverall';
        if (period === '1month') cacheKey = 'top30d';
        if (period === '3month') cacheKey = 'top90d';
        if (period === '12month') cacheKey = 'top12m';

        const now = Date.now();

        if (artistCache[cacheKey].data && (now - artistCache[cacheKey].timestamp < CACHE_TTL)) {
            return artistCache[cacheKey].data;
        }

        try {
            const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopartists&user=${encodeURIComponent(LASTFM_USER)}&period=${period}&limit=500&api_key=${LASTFM_API_KEY}&format=json`;
            const response = await fetch(url);
            const data = await response.json();
            const list = data.topartists?.artist || [];

            const artistMap = new Map();
            list.forEach(item => {
                artistMap.set(item.name.toLowerCase(), {
                    rank: item['@attr']?.rank || '?',
                    playcount: item.playcount || '0'
                });
            });

            artistCache[cacheKey] = { data: artistMap, timestamp: now };
            return artistMap;
        } catch (err) {
            console.error(`[Last.fm] Fehler beim Laden der Top Artists (${period}):`, err);
            return new Map();
        }
    }

    async function fetchTrackPlaycount(artist, title) {
        try {
            const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&username=${encodeURIComponent(LASTFM_USER)}&api_key=${LASTFM_API_KEY}&format=json`;
            const response = await fetch(url);
            const data = await response.json();
            return data.track?.userplaycount || '0';
        } catch {
            return null;
        }
    }

    async function fetchArtistOverallPlaycount(artist) {
        try {
            const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&artist=${encodeURIComponent(artist)}&username=${encodeURIComponent(LASTFM_USER)}&api_key=${LASTFM_API_KEY}&format=json`;
            const response = await fetch(url);
            const data = await response.json();
            return data.artist?.stats?.userplaycount || '0';
        } catch {
            return '0';
        }
    }

    async function fetchLastFmData() {
        if (!LASTFM_USER || !LASTFM_API_KEY || LASTFM_API_KEY === 'DEIN_LASTFM_API_KEY') {
            return { error: 'API Config fehlt' };
        }
        try {
            const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(LASTFM_USER)}&api_key=${LASTFM_API_KEY}&format=json&limit=1`;
            const response = await fetch(url);
            const data = await response.json();

            if (data.recenttracks && data.recenttracks.track) {
                const tracks = Array.isArray(data.recenttracks.track) ? data.recenttracks.track : [data.recenttracks.track];
                const latest = tracks[0];

                if (latest) {
                    const artist = latest.artist ? (latest.artist['#text'] || latest.artist.name) : 'Unbekannt';
                    const title = latest.name || 'Unbekannt';

                    const [trackPlaycount, map30d, map90d, map12m, mapOverall] = await Promise.all([
                        fetchTrackPlaycount(artist, title),
                        getTopArtistsMap('1month'),
                        getTopArtistsMap('3month'),
                        getTopArtistsMap('12month'),
                        getTopArtistsMap('overall')
                    ]);

                    const artistKey = artist.toLowerCase();
                    const stats30d = map30d.get(artistKey);
                    const stats90d = map90d.get(artistKey);
                    const stats12m = map12m.get(artistKey);
                    const statsOverall = mapOverall.get(artistKey);

                    const rawPlays30d = stats30d ? Number(stats30d.playcount) : 0;
                    const rawPlays90d = stats90d ? Number(stats90d.playcount) : 0;
                    const rawPlays12m = stats12m ? Number(stats12m.playcount) : 0;

                    const plays30d = rawPlays30d.toLocaleString('de-DE');
                    const plays90d = rawPlays90d.toLocaleString('de-DE');
                    const plays12m = rawPlays12m.toLocaleString('de-DE');
                    const rankOverall = statsOverall ? `#${statsOverall.rank}` : '500+';

                    let rawPlaysOverall = statsOverall?.playcount;
                    if (!rawPlaysOverall) {
                        rawPlaysOverall = await fetchArtistOverallPlaycount(artist);
                    }
                    const playsOverall = Number(rawPlaysOverall).toLocaleString('de-DE');

                    return {
                        artist, title, trackPlaycount,
                        plays30d, plays90d, plays12m,
                        rawPlays30d, rawPlays90d, rawPlays12m,
                        rankOverall, playsOverall
                    };
                }
            }
        } catch (err) {
            console.error('[Last.fm Spotify Integration]', err);
        }
        return null;
    }

    function createBadge() {
        const badge = document.createElement('div');
        badge.id = 'lastfm-spotify-badge';
        badge.style.cssText = `
            position: absolute;
            right: 309px;
            top: 49%;
            transform: translateY(-50%);
            z-index: 9999;
            display: flex;
            flex-direction: column;
            gap: 5px;
            width: 480px;
            box-sizing: border-box;
            padding: 8px 10px;
            background: rgba(18, 18, 18, 0.7);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            font-family: JetBrains Mono, monospace, sans-serif;
            font-size: 0.8rem;
            color: #b3b3b3;
            white-space: nowrap;
            user-select: none;
            pointer-events: auto;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        `;

        badge.innerHTML = `
            <!-- 2-ZEILEN LAYOUT (DEFAULT >= 2320px) -->
            <div class="lastfm-view-2row">
                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 8px; flex-grow: 1; overflow: hidden; min-width: 0; padding-right: 8px; margin-left: -4px;">
                        <div class="lastfm-cover-wrapper" style="width: 20px; height: 20px; border-radius: 4px; overflow: hidden; display: block; flex-shrink: 0; background: #282828;">
                            <img class="lastfm-cover-img" src="${DEFAULT_COVER_SVG}" style="width: 100%; height: 100%; object-fit: cover;" />
                        </div>
                        <div class="lastfm-ticker-container">
                            <div class="lastfm-ticker-content lastfm-track-title" style="color: #ffffff; font-weight: 500;">Lade...</div>
                        </div>
                    </div>
                    <div class="lastfm-track-count" style="flex-shrink: 0; color: #55ff00; font-size: 0.71rem; font-weight: 500;"></div>
                </div>

                <div style="height: 1px; background: rgba(255, 255, 255, 0.08); width: 100%; margin: 1px 0;"></div>

                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; font-size: 0.71rem;">
                    <div style="display: flex; align-items: center; gap: 3.5px;">
                        <a href="https://www.last.fm/de/user/" target="_blank" style="display: inline-flex; align-items: center; padding: 4px 6px; margin: -4px -6px; text-decoration: none; border-radius: 4px;">
                            <span style="color: #d51007; font-weight: bold; font-family: sans-serif; cursor: pointer;">fm</span>
                        </a>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;">30D: <span class="lastfm-30d-text" style="color: #ffffff; font-weight:300;">-</span></span>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;">90D: <span class="lastfm-90d-text" style="color: #ffffff; font-weight:300;">-</span></span>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;">12M: <span class="lastfm-12m-text" style="color: #ffffff; font-weight:300;">-</span></span>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;" title="All-Time Scrobbles">∞: <span class="lastfm-overall-text" style="color: #ffffff; font-weight:500;">-</span></span>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-shrink: 0;">
                        <div class="lastfm-trend-box" style="display: flex; align-items: center; height: 12px;"></div>
                        <!--<span style="color: rgba(255, 255, 255, 0.2);">|</span> -->
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <span style="color: #888888;">Rank:</span>
                            <span class="lastfm-rank-text" style="color: #55ff00; font-weight:400;">-</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 3-ZEILEN LAYOUT (BREAKPOINT < 2320px) -->
            <div class="lastfm-view-3row">
                <div style="display: flex; align-items: center; gap: 8px; width: 100%; overflow: hidden;">
                    <div class="lastfm-cover-wrapper" style="width: 20px; height: 20px; border-radius: 4px; overflow: hidden; display: block; flex-shrink: 0; background: #282828;">
                        <img class="lastfm-cover-img" src="${DEFAULT_COVER_SVG}" style="width: 100%; height: 100%; object-fit: cover;" />
                    </div>
                    <div class="lastfm-ticker-container">
                        <div class="lastfm-ticker-content lastfm-track-title" style="color: #ffffff; font-weight: 500;">Lade...</div>
                    </div>
                </div>

                <div style="height: 1px; background: rgba(255, 255, 255, 0.08); width: 100%; margin: 1px 0;"></div>

                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; font-size: 0.71rem;">
                    <a href="https://www.last.fm/de/user/" target="_blank" style="display: inline-flex; align-items: center; padding: 4px 6px; margin: -4px -6px; text-decoration: none; border-radius: 4px;">
                        <span style="color: #d51007; font-weight: bold; font-family: sans-serif; cursor: pointer;">fm</span>
                    </a>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;">30D: <strong class="lastfm-30d-text" style="color: #ffffff;">-</strong></span>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;">90D: <strong class="lastfm-90d-text" style="color: #ffffff;">-</strong></span>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;">12M: <strong class="lastfm-12m-text" style="color: #ffffff;">-</strong></span>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;" title="All-Time Scrobbles">∞: <strong class="lastfm-overall-text" style="color: #ffffff;">-</strong></span>
                    </div>
                    <div style="display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-shrink: 0;">
                        <div class="lastfm-trend-box" style="display: flex; align-items: center; height: 12px;"></div>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <span style="color: #888888;">Rank:</span>
                            <strong class="lastfm-rank-text" style="color: #55ff00;">-</strong>
                        </div>
                    </div>
                </div>

                <div style="height: 1px; background: rgba(255, 255, 255, 0.08); width: 100%; margin: 1px 0;"></div>

                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; font-size: 0.71rem;">
                    <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; min-width: 0;">
                        <span style="color: #888888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"><strong class="lastfm-artist-text" style="color: #ffffff;">-</strong></span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                        <span style="color: #888888;">30D: <strong class="lastfm-30d-text" style="color: #ffffff;">-</strong></span>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;">90D: <strong class="lastfm-90d-text" style="color: #ffffff;">-</strong></span>
                        <span style="color: rgba(255, 255, 255, 0.2);">|</span>
                        <span style="color: #888888;">12M: <strong class="lastfm-12m-text" style="color: #ffffff;">-</strong></span>
                    </div>
                </div>
            </div>
        `;

        return badge;
    }

    function setAllText(selector, text) {
        document.querySelectorAll(selector).forEach(el => {
            el.textContent = text;
        });
    }

    function updateTrendIndicator(raw30d, raw90d) {
        const r30 = Number(raw30d) || 0;
        const r90 = (Number(raw90d) || 0) / 3;

        let f = 0;
        const maxVal = Math.max(r30, r90);

        // Berechnet die Steigung von -1 (Abfall) über 0 (Neutral) bis +1 (Anstieg)
        if (maxVal > 0) {
            f = (r30 - r90) / maxVal;
        }

        // Farben: Last.fm Rot, Neutrales Text-Grau, oder unser Grün
        let color = '#888888';
        if (f > 0.1) {
            color = '#55ff00';
        } else if (f < -0.1) {
            color = '#d51007';
        }

        // SVG ist 12px hoch, Mitte ist bei Y=6.
        // Wir schlagen maximal 5px nach oben/unten aus, damit die Linie nicht abgeschnitten wird.
        const y1 = 6 + (f * 5); // Startpunkt links
        const y2 = 6 - (f * 5); // Endpunkt rechts

        // Wir lassen links und rechts (x1=1, x2=31) 1px Platz für die abgerundeten Linienenden
        const svg = `
            <svg width="32" height="12" viewBox="0 0 32 12" style="display: block;">
                <line x1="1" y1="${y1}" x2="31" y2="${y2}" stroke="${color}" stroke-width="2" stroke-linecap="round" />
            </svg>
        `;

        document.querySelectorAll('.lastfm-trend-box').forEach(box => {
            box.innerHTML = svg;
        });
    }

    async function updateBadge() {
        if (!document.getElementById('lastfm-spotify-badge')) return;

        const targetCoverUrl = hasStartedPlaying
            ? (getSpotifyCoverUrl() || DEFAULT_COVER_SVG)
            : DEFAULT_COVER_SVG;

        document.querySelectorAll('.lastfm-cover-img').forEach(img => {
            img.src = targetCoverUrl;
        });
        document.querySelectorAll('.lastfm-cover-wrapper').forEach(wrapper => {
            wrapper.style.display = 'block';
        });

        const data = await fetchLastFmData();
        if (data?.artist && data?.title) {
            const trackText = `<strong style="color: #ffffff;">${escapeHtml(data.artist)}</strong> - ${escapeHtml(data.title)}`;
            const spacer = `<span style="display: inline-block; width: 50px;"></span>`;

            document.querySelectorAll('.lastfm-track-title').forEach(el => {
                // 1. Reset auf Standard (Kein Scrollen, normales Verhalten)
                el.classList.remove('is-scrolling');
                el.parentElement.classList.remove('is-scrolling-mask');
                el.innerHTML = trackText;

                // 2. Kurz warten bis der DOM aktualisiert wurde, um zu messen
                requestAnimationFrame(() => {
                    // 3. Prüfen: Ist der Text breiter als der verfügbare Platz?
                    if (el.scrollWidth > el.clientWidth) {
                        // Ja -> Animation an und Text für den Loop verdoppeln!
                        el.classList.add('is-scrolling');
                        el.parentElement.classList.add('is-scrolling-mask');
                        el.innerHTML = `${trackText}${spacer}${trackText}${spacer}`;
                    }
                });
            });

            setAllText('.lastfm-track-count', data.trackPlaycount !== null ? `(${data.trackPlaycount}⨯)` : '-');
            setAllText('.lastfm-artist-text', data.artist);

            setAllText('.lastfm-30d-text', `${data.plays30d}⨯`);
            setAllText('.lastfm-90d-text', `${data.plays90d}⨯`);
            setAllText('.lastfm-12m-text', `${data.plays12m}⨯`);
            setAllText('.lastfm-overall-text', `${data.playsOverall}⨯`);
            setAllText('.lastfm-rank-text', data.rankOverall);
            updateTrendIndicator(data.rawPlays30d, data.rawPlays90d);
        } else if (data?.error) {
            setAllText('.lastfm-track-title', data.error);
            setAllText('.lastfm-track-count', '-');
        }
    }

    const injectFn = function () {
        if (document.getElementById('lastfm-spotify-badge')) return;

        const playerFooter = document.querySelector('footer') || document.querySelector('[data-testid="now-playing-bar"]');

        if (playerFooter) {
            if (window.getComputedStyle(playerFooter).position === 'static') {
                playerFooter.style.position = 'relative';
            }

            const badge = createBadge();
            playerFooter.appendChild(badge);
            updateBadge();
        }
    };

    window.injectIntoPlayer = injectFn;
    window.injectintoplayer = injectFn;

    // Nur noch EIN sauberer Observer-Block ganz am Ende
    const observer = new MutationObserver(() => {
        window.injectIntoPlayer();
        checkTrackChange();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    window.injectIntoPlayer();
    setInterval(checkTrackChange, 1000);
})();