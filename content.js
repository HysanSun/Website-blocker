// ============================================================
// content.js — Dual-layer defense for Website Blocker v2.0
// Supports: complete blocks, timed blocks (with daily usage check), keyword
//           blocks, and focus-session enforcement. Runs at document_start.
// ============================================================

function getTodayKey() {
    return new Date().toLocaleDateString('zh-CN');
}

// The block page is told which host sent the tab there so it can offer a timed
// way back in. The value comes from a rule the user wrote, and the worker
// normalizes it again before anything is stored.
function redirectToBlockPage(host) {
    var path = 'blockpage.html';
    var query = [];
    if (host) query.push('host=' + encodeURIComponent(host));
    // The exact page, so "Unlock" lands back where the user was rather than on
    // the bare host.
    query.push('url=' + encodeURIComponent(window.location.href));
    if (query.length) path += '?' + query.join('&');
    window.location.href = chrome.runtime.getURL(path);
}

// A rule may carry a window; outside it the rule is simply not on the list.
// Mirrors ruleWindowActive() in background.js.
function parseClock(text) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text).trim());
    if (!m) return null;
    var h = Number(m[1]);
    var mm = Number(m[2]);
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
}

function ruleWindowActive(rule, now) {
    var win = rule && rule.window;
    if (!win || typeof win !== 'object') return true;
    var from = parseClock(win.from);
    var to = parseClock(win.to);
    if (from === null || to === null) return true;
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var crosses = from > to;
    var inRange = crosses ? (nowMin >= from || nowMin < to) : (nowMin >= from && nowMin < to);
    var days = (win.days && win.days.length) ? win.days : null;
    if (!days) return inRange;
    var day = now.getDay();
    var belongsTo = (crosses && nowMin < to) ? (day + 6) % 7 : day;
    return inRange && days.indexOf(belongsTo) !== -1;
}

// "Let me through for 30 minutes" is stored by the worker as {host: until}.
function tempUnlockActive(raw, host, now) {
    if (!raw || typeof raw !== 'object') return false;
    for (var key in raw) {
        if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
        if (!(Number(raw[key]) > now)) continue;
        if (hostMatches(host, key)) return true;
    }
    return false;
}

// A rule value covers its host and every subdomain of it, and nothing else:
// 'x.com' matches x.com and a.x.com, never notx.com. This mirrors the
// declarativeNetRequest urlFilter `||x.com^`, so the second line of defence no
// longer fires on substrings like 'notbaidu.com' or a ?ref=baidu.com link.
function hostMatches(host, value) {
    var h = String(host || '').toLowerCase();
    var d = String(value || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/^\*\./, '')
        .replace(/^\./, '');
    return !!d && (h === d || h.endsWith('.' + d));
}

// A rule value starting with '!' is an exception: never block this host, or
// anything under it. When you block baidu.com you also close pan.baidu.com (that
// is what the urlFilter does), and this is how you keep one of them reachable.
function isException(rule) {
    return !!(rule && typeof rule.val === 'string' && rule.val.trim().charAt(0) === '!');
}

function exceptionHost(rule) {
    return String((rule && rule.val) || '').trim().slice(1).trim();
}

function checkAndBlock() {
    // Guard: never redirect on the extension's own pages
    var extUrl = chrome.runtime.getURL('');
    if (window.location.href.startsWith(extUrl)) {
        return;
    }

    // Read rules from sync storage + daily usage from local storage
    chrome.storage.sync.get(['blockedItems'], function (syncRes) {
        var rules = syncRes.blockedItems || [];

        // Separate timed rules from complete-block rules
        var completeRules = [];
        var timedRules = [];
        var exceptionRules = [];

        for (var i = 0; i < rules.length; i++) {
            var rule = rules[i];
            if (isException(rule)) {
                exceptionRules.push(rule);
                continue;
            }
            // Support both old format (no type) and new format
            var ruleType = rule.type || 'block';
            if (ruleType === 'timed' && rule.mode === 'website') {
                timedRules.push(rule);
            } else {
                completeRules.push(rule);
            }
        }

        var currentUrl = window.location.href.toLowerCase();
        var host = window.location.hostname.toLowerCase();

        // A temporary unlock is the same allow rule as an exception, only with
        // an expiry, so it wins in exactly the same place.
        chrome.storage.local.get(['dailyUsage', 'pomodoro', 'tempUnlocks'], function (localRes) {
            var now = new Date();
            if (tempUnlockActive(localRes.tempUnlocks, host, now.getTime())) return;

            // An exception wins over every rule below, whatever their type.
            for (var e = 0; e < exceptionRules.length; e++) {
                if (hostMatches(host, exceptionHost(exceptionRules[e]))) {
                    return;
                }
            }

            // 1. Check complete block rules first (always enforced)
            for (var j = 0; j < completeRules.length; j++) {
                var item = completeRules[j];
                if (!ruleWindowActive(item, now)) continue;
                if (item.mode === 'website') {
                    if (hostMatches(host, item.val)) {
                        redirectToBlockPage(item.val);
                        return;
                    }
                } else if (item.mode === 'keyword') {
                    if (currentUrl.indexOf('q=') !== -1 && currentUrl.indexOf(item.val) !== -1) {
                        redirectToBlockPage(null);
                        return;
                    }
                }
            }

            // 2. Check timed rules — need daily usage plus the pomodoro mirror
            var dailyUsage = localRes.dailyUsage || {};
            var today = getTodayKey();
            var todayUsage = dailyUsage[today] || {};
            // A running focus session blocks timed sites outright, whatever
            // today's usage is. The background state machine owns this flag.
            var strictNow = !!(localRes.pomodoro && localRes.pomodoro.strictNow);

            for (var k = 0; k < timedRules.length; k++) {
                var timedRule = timedRules[k];
                if (!ruleWindowActive(timedRule, now)) continue;
                if (hostMatches(host, timedRule.val)) {
                    var usedMs = todayUsage[timedRule.val] || 0;
                    var limitMs = (timedRule.limitMin || 30) * 60 * 1000;
                    if (strictNow || usedMs >= limitMs) {
                        redirectToBlockPage(timedRule.val);
                        return;
                    }
                }
            }
        });
    });
}

// Run immediately when page loads
checkAndBlock();

// Also check on URL changes (SPA navigation)
window.addEventListener('popstate', checkAndBlock);
window.addEventListener('hashchange', checkAndBlock);
