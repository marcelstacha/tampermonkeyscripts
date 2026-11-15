// ==UserScript==
// @name         Spotify Custom Expand Library Button
// @namespace    http://tampermonkey.net/
// @version      4.3
// @description  48x48px Button mit weißer Kontur zum Ein-/Ausklappen der Library + kompakte 1-Zeilen-Leiste
// @match        https://open.spotify.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const BTN_ID = 'custom-spotify-library-toggle-btn';
    const STYLE_ID = 'custom-spotify-library-header-css';
    let rafPending = false;
    let positionLockedUntil = 0;

    const EXPAND_SVG = `
        <svg data-encore-id="icon" role="img" aria-hidden="true" viewBox="0 0 16 16" style="fill: currentColor; width: 20px; height: 20px; pointer-events: none;">
            <path d="M6.53 9.47a.75.75 0 0 1 0 1.06l-2.72 2.72h1.018a.75.75 0 0 1 0 1.5H1.25v-3.579a.75.75 0 0 1 1.5 0v1.018l2.72-2.72a.75.75 0 0 1 1.06 0zm2.94-2.94a.75.75 0 0 1 0-1.06l2.72-2.72h-1.018a.75.75 0 1 1 0-1.5h3.578v3.579a.75.75 0 0 1-1.5 0V3.81l-2.72 2.72a.75.75 0 0 1-1.06 0"></path>
        </svg>
    `;

    const MINIMIZE_SVG = `
        <svg data-encore-id="icon" role="img" aria-hidden="true" viewBox="0 0 16 16" style="fill: currentColor; width: 20px; height: 20px; pointer-events: none;">
            <path d="M14.53 1.47a.75.75 0 0 1 0 1.06L11.81 5.25h1.018a.75.75 0 0 1 0 1.5H9.25V3.172a.75.75 0 0 1 1.5 0v1.018l2.72-2.72a.75.75 0 0 1 1.06 0zM1.47 14.53a.75.75 0 0 1 0-1.06l2.72-2.72H3.172a.75.75 0 0 1 0-1.5H6.75v3.578a.75.75 0 0 1-1.5 0v-1.018l-2.72 2.72a.75.75 0 0 1-1.06 0z"></path>
        </svg>
    `;

    function getSidebarContainer() {
        return document.querySelector('#Desktop_LeftSidebar_Id');
    }

    function getMainViewContainer() {
        return document.querySelector('[data-testid="main-view"]')
            || document.querySelector('.main-view-container')
            || document.querySelector('main')?.parentElement;
    }

    function isLibraryExpanded() {
        const sidebar = getSidebarContainer();
        if (!sidebar) return false;

        if (sidebar.querySelector('button[aria-label="Minimize Your Library"], button[aria-label="Bibliothek verkleinern"]')) {
            return true;
        }

        const computed = window.getComputedStyle(sidebar);
        return (
            computed.gridArea.includes('main-view') ||
            sidebar.style.width === '100%' ||
            sidebar.getBoundingClientRect().width > 500
        );
    }

    function findNativeLibraryButton(expanded) {
        const sidebar = getSidebarContainer() || document;

        if (expanded) {
            return (
                sidebar.querySelector('button[aria-label="Minimize Your Library"]') ||
                sidebar.querySelector('button[aria-label="Bibliothek verkleinern"]') ||
                sidebar.querySelector('button[aria-label*="Minimize"]') ||
                sidebar.querySelector('button[aria-label*="verkleinern"]')
            );
        }

        return (
            sidebar.querySelector('button[aria-label="Expand Your Library"]') ||
            sidebar.querySelector('button[aria-label="Bibliothek erweitern"]') ||
            sidebar.querySelector('button[aria-label*="Expand"]') ||
            sidebar.querySelector('button[aria-label*="erweitern"]') ||
            Array.from(sidebar.querySelectorAll('button')).find((btn) => {
                const path = btn.querySelector('svg path')?.getAttribute('d') || '';
                return path.startsWith('M6.53 9.47') || path.startsWith('M14.78 2.28');
            }) ||
            null
        );
    }

    function applyButtonVisualState(customBtn, expanded, nativeBtn) {
        if (!customBtn) return;

        const targetLabel = nativeBtn?.getAttribute('aria-label')
            || (expanded ? 'Minimize Your Library' : 'Expand Your Library');

        if (customBtn.getAttribute('aria-label') !== targetLabel) {
            customBtn.setAttribute('aria-label', targetLabel);
        }

        if (customBtn.dataset.state !== String(expanded)) {
            customBtn.innerHTML = expanded ? MINIMIZE_SVG : EXPAND_SVG;
            customBtn.dataset.state = String(expanded);
        }
    }

    function createCustomButton() {
        const wrapper = document.createElement('div');
        wrapper.id = BTN_ID;

        Object.assign(wrapper.style, {
            position: 'fixed',
            top: '68px',
            right: '10px',
            zIndex: '2147483647',
            width: '48px',
            height: '48px',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '50%',
            border: '1.5px solid #ffffff',
            backgroundColor: '#121212',
            opacity: '1',
            visibility: 'visible',
            transition: 'background-color 350ms ease',
            pointerEvents: 'auto'
        });

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Expand Your Library');

        Object.assign(btn.style, {
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '50%',
            border: 'none',
            background: 'transparent',
            color: '#ffffff',
            cursor: 'pointer',
            padding: '0',
            transition: 'color 350ms ease'
        });

        btn.innerHTML = EXPAND_SVG;

        wrapper.addEventListener('mouseenter', () => {
            btn.style.color = '#1ed760';
            wrapper.style.backgroundColor = '#1f1f1f';
        });

        wrapper.addEventListener('mouseleave', () => {
            btn.style.color = '#ffffff';
            wrapper.style.backgroundColor = '#121212';
        });

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const expanded = isLibraryExpanded();
            const nativeBtn = findNativeLibraryButton(expanded);

            if (nativeBtn) {
                // Position während der Layout-Umschaltung einfrieren, damit kein Zwischen-Frame den Button verschiebt
                positionLockedUntil = performance.now() + 350;
                applyButtonVisualState(btn, !expanded, null);
                nativeBtn.click();
            } else {
                console.warn(
                    `[Custom Spotify Button] Button "${expanded ? 'Minimize Your Library' : 'Expand Your Library'}" nicht gefunden.`
                );
            }
        });

        wrapper.appendChild(btn);
        return wrapper;
    }

    function updateButtonPosition(wrapper) {
        if (performance.now() < positionLockedUntil) return;

        const mainView = getMainViewContainer();
        const sidebar = getSidebarContainer();
        const mainRect = mainView?.getBoundingClientRect();
        const sidebarRect = sidebar?.getBoundingClientRect();

        // Beide Container teilen sich exakt dieselbe obere Kante unter der globalen Suchleiste
        const topBase = (sidebarRect && sidebarRect.height > 100)
            ? sidebarRect.top
            : (mainRect && mainRect.height > 100 ? mainRect.top : null);

        // Nur gültige rechte Panel-Kanten (> 55 % der Fensterbreite) akzeptieren, niemals kollabierte Zwischenzustände
        const minValidRight = window.innerWidth * 0.55;
        let rightBase = null;

        if (sidebarRect && sidebarRect.width > 500 && sidebarRect.right > minValidRight) {
            rightBase = sidebarRect.right;
        } else if (mainRect && mainRect.width > 250 && mainRect.right > minValidRight) {
            rightBase = mainRect.right;
        } else if (sidebarRect && sidebarRect.width > 250 && sidebarRect.right > minValidRight) {
            rightBase = sidebarRect.right;
        }

        if (topBase != null) {
            const newTop = `${Math.max(0, Math.round(topBase)) + 4}px`;
            if (wrapper.style.top !== newTop) {
                wrapper.style.top = newTop;
            }
        }

        if (rightBase != null) {
            const newRight = `${Math.max(0, Math.round(window.innerWidth - rightBase)) + 10}px`;
            if (wrapper.style.right !== newRight) {
                wrapper.style.right = newRight;
            }
        }
    }

    function syncButton() {
        const mainView = getMainViewContainer();
        const sidebar = getSidebarContainer();
        let wrapper = document.getElementById(BTN_ID);

        if (!mainView && !sidebar) {
            if (wrapper) wrapper.remove();
            return;
        }

        if (!wrapper) {
            wrapper = createCustomButton();
            document.body.appendChild(wrapper);
        }

        updateButtonPosition(wrapper);

        const expanded = isLibraryExpanded();
        const nativeBtn = findNativeLibraryButton(expanded);
        const customBtn = wrapper.querySelector('button');
        applyButtonVisualState(customBtn, expanded, nativeBtn);
    }

    function scheduleSync() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
            rafPending = false;
            injectCSS();
            syncButton();
        });
    }

    function injectCSS() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* Button gegen View-Transitions und externe Overrides absichern */
            #${BTN_ID} {
                position: fixed !important;
                z-index: 2147483647 !important;
                opacity: 1 !important;
                visibility: visible !important;
                display: flex !important;
                background-color: #121212 !important;
                view-transition-name: custom-spotify-library-btn !important;
            }

            #${BTN_ID}:hover {
                background-color: #1f1f1f !important;
            }

            ::view-transition-group(custom-spotify-library-btn),
            ::view-transition-old(custom-spotify-library-btn),
            ::view-transition-new(custom-spotify-library-btn) {
                animation: none !important;
                mix-blend-mode: normal !important;
            }

            /* 0. Nativen Expand/Minimize-Button links bei "Your Library" in jedem Zustand ausblenden */
            #Desktop_LeftSidebar_Id header button[aria-label="Expand Your Library"],
            #Desktop_LeftSidebar_Id header button[aria-label="Minimize Your Library"],
            #Desktop_LeftSidebar_Id header button[aria-label="Bibliothek erweitern"],
            #Desktop_LeftSidebar_Id header button[aria-label="Bibliothek verkleinern"],
            #Desktop_LeftSidebar_Id .xA7iFhIE3CdUBJNhLfwL > button:not([aria-label="Create"]):not([aria-label="Erstellen"]),
            #Desktop_LeftSidebar_Id header div:has(> button[aria-label="Create"]) > button:not([aria-label="Create"]),
            #Desktop_LeftSidebar_Id header div:has(> button[aria-label="Erstellen"]) > button:not([aria-label="Erstellen"]) {
                display: none !important;
            }

            /* 1. "Your Library" Header im expandierten Zustand sofort entfernen */
            #Desktop_LeftSidebar_Id:has(button[aria-label="Minimize Your Library"]) header,
            #Desktop_LeftSidebar_Id:has(button[aria-label="Bibliothek verkleinern"]) header,
            #Desktop_LeftSidebar_Id.eaQK5Z8sUjCmDnJEf5Kk header,
            #Desktop_LeftSidebar_Id[style*="width: 100%"] header {
                display: none !important;
            }

            /* 2. Obere Leiste strikt auf 56px Höhe (4px + 48px Button + 4px) */
            #Desktop_LeftSidebar_Id:has(button[aria-label="Minimize Your Library"]) .ziR6VlU1xb5TpEc1Qnul,
            #Desktop_LeftSidebar_Id:has(button[aria-label="Bibliothek verkleinern"]) .ziR6VlU1xb5TpEc1Qnul,
            #Desktop_LeftSidebar_Id.eaQK5Z8sUjCmDnJEf5Kk .ziR6VlU1xb5TpEc1Qnul,
            #Desktop_LeftSidebar_Id[style*="width: 100%"] .ziR6VlU1xb5TpEc1Qnul,
            #Desktop_LeftSidebar_Id:has(button[aria-label="Minimize Your Library"]) div:has(> [data-testid="carousel-scroller"]),
            #Desktop_LeftSidebar_Id:has(button[aria-label="Bibliothek verkleinern"]) div:has(> [data-testid="carousel-scroller"]) {
                display: flex !important;
                flex-direction: row !important;
                align-items: center !important;
                justify-content: space-between !important;
                height: 56px !important;
                min-height: 56px !important;
                max-height: 56px !important;
                padding: 0 16px !important;
                margin: 0 !important;
                box-shadow: none !important;
                box-sizing: border-box !important;
            }

            /* Innere Filter-Leiste von vertikalen Paddings befreien */
            #Desktop_LeftSidebar_Id:has(button[aria-label="Minimize Your Library"]) .W7ETd1fZHm0MV0Jqtjeu,
            #Desktop_LeftSidebar_Id:has(button[aria-label="Bibliothek verkleinern"]) .W7ETd1fZHm0MV0Jqtjeu,
            #Desktop_LeftSidebar_Id.eaQK5Z8sUjCmDnJEf5Kk .W7ETd1fZHm0MV0Jqtjeu,
            #Desktop_LeftSidebar_Id[style*="width: 100%"] .W7ETd1fZHm0MV0Jqtjeu {
                padding: 0 !important;
                margin: 0 !important;
                display: flex !important;
                align-items: center !important;
            }

            /* 3. Suche & Sortierung: 5rem Abstand rechts für den Custom-Button + kein Abschneiden */
            #Desktop_LeftSidebar_Id:has(button[aria-label="Minimize Your Library"]) .lbisZ4LOMexiD3YW9ATM,
            #Desktop_LeftSidebar_Id:has(button[aria-label="Bibliothek verkleinern"]) .lbisZ4LOMexiD3YW9ATM,
            #Desktop_LeftSidebar_Id.eaQK5Z8sUjCmDnJEf5Kk .lbisZ4LOMexiD3YW9ATM,
            #Desktop_LeftSidebar_Id[style*="width: 100%"] .lbisZ4LOMexiD3YW9ATM,
            #Desktop_LeftSidebar_Id:has(button[aria-label="Minimize Your Library"]) div:has(> [role="search"]),
            #Desktop_LeftSidebar_Id:has(button[aria-label="Bibliothek verkleinern"]) div:has(> [role="search"]) {
                display: flex !important;
                align-items: center !important;
                gap: 10px !important;
                margin-right: 5rem !important;
                padding: 0 !important;
                flex-shrink: 0 !important;
            }

            /* 4. "Custom Order" nicht abschneiden */
            #Desktop_LeftSidebar_Id:has(button[aria-label="Minimize Your Library"]) button[aria-controls="sort-and-view-picker"],
            #Desktop_LeftSidebar_Id:has(button[aria-label="Bibliothek verkleinern"]) button[aria-controls="sort-and-view-picker"],
            #Desktop_LeftSidebar_Id.eaQK5Z8sUjCmDnJEf5Kk button[aria-controls="sort-and-view-picker"],
            #Desktop_LeftSidebar_Id[style*="width: 100%"] button[aria-controls="sort-and-view-picker"] {
                flex-shrink: 0 !important;
                max-width: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    const origPushState = history.pushState;
    history.pushState = function (...args) {
        origPushState.apply(this, args);
        scheduleSync();
    };

    const origReplaceState = history.replaceState;
    history.replaceState = function (...args) {
        origReplaceState.apply(this, args);
        scheduleSync();
    };

    window.addEventListener('popstate', scheduleSync);
    window.addEventListener('resize', scheduleSync);

    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'aria-label']
    });

    injectCSS();
    syncButton();
})();
