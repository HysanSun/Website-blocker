// ============================================================
// pomodoro-entry.js - the two small entry points that live on blockpage.html:
// the stopwatch button in the top bar, and the status line on the blocked
// page. The full UI lives in pomodoro.html; this script only opens it and
// shows a countdown.
//
// Wrapped in an IIFE because it shares the global scope with streaks.js and
// must not collide with its top-level bindings.
// ============================================================
(function () {
    'use strict';

    var POMODORO_PAGE = 'pomodoro.html';
    var fullPage = window.matchMedia('(min-width: 400px)');
    var line = document.getElementById('pomodoro-line');
    var cached = null;
    var tickInFlight = false;

    function openPomodoroWindow() {
        chrome.windows.getAll({ populate: true }, function (wins) {
            var existing = null;
            (wins || []).forEach(function (w) {
                if (existing) return;
                var tabs = w.tabs || [];
                for (var i = 0; i < tabs.length; i++) {
                    if ((tabs[i].url || '').indexOf(POMODORO_PAGE) !== -1) {
                        existing = w;
                        return;
                    }
                }
            });
            if (existing) {
                chrome.windows.update(existing.id, { focused: true });
                return;
            }
            chrome.windows.create({
                url: chrome.runtime.getURL(POMODORO_PAGE),
                type: 'popup',
                width: 460,
                height: 660
            });
        });
    }

    var pomodoroBtn = document.getElementById('pomodoro-btn');
    if (pomodoroBtn) {
        pomodoroBtn.addEventListener('click', function (e) {
            e.preventDefault();
            openPomodoroWindow();
        });
    }

    // --- way out of a blocked page (full-page form only) ---
    var leaveBtn = document.getElementById('leave-btn');
    if (leaveBtn) {
        leaveBtn.addEventListener('click', function () {
            // A tab that was redirected here cannot always close itself - only
            // a script-opened tab can - so try that first and fall back to
            // whatever the tab was showing before.
            window.close();
            setTimeout(function () {
                if (!window.closed && history.length > 1) history.back();
            }, 150);
        });
    }

    // --- timed way back in (full-page form only) ---
    var unlockRow = document.getElementById('unlock-row');
    var unlockBtn = document.getElementById('unlock-btn');
    var unlockNote = document.getElementById('unlock-note');
    var params = new URLSearchParams(window.location.search);
    var blockedVal = params.get('host') || '';
    var blockedUrl = params.get('url') || '';
    // The redirect carries a rule value, which may be a bare host, a subdomain
    // or a keyword. Only a website rule can be unlocked.
    var unlockHost = blockedVal.replace(/^!/, '').replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '').replace(/^\*\./, '').replace(/^\./, '').toLowerCase();

    function destinationFor(host) {
        if (blockedUrl && /^https?:\/\//i.test(blockedUrl)) return blockedUrl;
        return 'https://' + host + '/';
    }

    function refreshUnlock() {
        if (!unlockRow || !unlockHost) return;
        chrome.runtime.sendMessage({ action: 'getTempUnlocks' }, function (res) {
            var unlocks = (res && res.success && res.tempUnlocks) ? res.tempUnlocks : [];
            var mine = null;
            unlocks.forEach(function (u) {
                if (unlockHost === u.host || unlockHost.slice(-(u.host.length + 1)) === '.' + u.host) mine = u;
            });
            unlockRow.hidden = false;
            if (mine) {
                var left = Math.max(1, Math.ceil((mine.until - Date.now()) / 60000));
                unlockBtn.textContent = 'Open ' + unlockHost;
                unlockNote.textContent = 'unlocked for ' + left + ' more min';
            } else {
                unlockBtn.textContent = 'Unlock 30 min';
                unlockNote.textContent = 'a one-off, it re-locks by itself';
            }
        });
    }

    if (unlockBtn) {
        unlockBtn.addEventListener('click', function () {
            if (!unlockHost) return;
            unlockBtn.disabled = true;
            chrome.runtime.sendMessage({ action: 'getTempUnlocks' }, function (res) {
                var unlocks = (res && res.success && res.tempUnlocks) ? res.tempUnlocks : [];
                var open = false;
                unlocks.forEach(function (u) { if (unlockHost === u.host) open = true; });
                if (open) { window.location.href = destinationFor(unlockHost); return; }
                chrome.runtime.sendMessage({ action: 'tempUnlock', val: unlockHost, minutes: 30 },
                    function (r2) {
                        if (r2 && r2.success) { window.location.href = destinationFor(unlockHost); return; }
                        unlockBtn.disabled = false;
                        refreshUnlock();
                    });
            });
        });
        refreshUnlock();
    }

    // --- blocked-page status line (full-page form only) ---
    if (!line || !fullPage.matches) return;

    function clockText(ms) {
        var total = Math.max(0, Math.ceil(ms / 1000));
        var m = Math.floor(total / 60);
        var s = total % 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function isPaused(state) {
        return state.pausedRemainingMs !== null && state.pausedRemainingMs !== undefined;
    }

    function remainingOf(state) {
        if (isPaused(state)) return Math.max(0, state.pausedRemainingMs);
        return Math.max(0, state.endAt - Date.now());
    }

    function paint() {
        if (!cached) return;
        var state = cached.state;
        if (state.phase === 'idle') {
            line.innerHTML = '<a href="#">Start a focus session</a>';
            var link = line.querySelector('a');
            if (link) {
                link.addEventListener('click', function (e) {
                    e.preventDefault();
                    openPomodoroWindow();
                });
            }
            return;
        }
        var label = (state.phase === 'focus') ? 'Focus in progress' : 'Break';
        if (isPaused(state)) label += ' (paused)';
        line.innerHTML = label + ' &middot; <strong>' + clockText(remainingOf(state)) + '</strong>';
    }

    function refresh() {
        chrome.runtime.sendMessage({ action: 'pomodoroGetState' }, function (res) {
            if (res && res.success) {
                cached = res;
                paint();
            }
        });
    }

    function forceTick() {
        if (tickInFlight) return;
        tickInFlight = true;
        chrome.runtime.sendMessage({ action: 'pomodoroTick' }, function () {
            tickInFlight = false;
            refresh();
        });
    }

    refresh();
    setInterval(refresh, 30000);
    // Paint locally between refreshes: endAt is absolute, so no messaging is
    // needed to keep the countdown honest.
    setInterval(function () {
        if (!cached || cached.state.phase === 'idle') return;
        paint();
        if (!isPaused(cached.state) && remainingOf(cached.state) <= 0) forceTick();
    }, 1000);
})();