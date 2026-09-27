// ============================================================
// content.js — Dual-layer defense for Website Blocker v2.0
// Supports: complete blocks, timed blocks (with daily usage check), keyword
//           blocks, and focus-session enforcement. Runs at document_start.
// ============================================================

function getTodayKey() {
    return new Date().toLocaleDateString('zh-CN');
}

function redirectToBlockPage() {
    window.location.href = chrome.runtime.getURL('blockpage.html');
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

        for (var i = 0; i < rules.length; i++) {
            var rule = rules[i];
            // Support both old format (no type) and new format
            var ruleType = rule.type || 'block';
            if (ruleType === 'timed' && rule.mode === 'website') {
                timedRules.push(rule);
            } else {
                completeRules.push(rule);
            }
        }

        var currentUrl = window.location.href.toLowerCase();

        // 1. Check complete block rules first (always enforced)
        for (var j = 0; j < completeRules.length; j++) {
            var item = completeRules[j];
            if (item.mode === 'website') {
                if (currentUrl.indexOf(item.val) !== -1) {
                    redirectToBlockPage();
                    return;
                }
            } else if (item.mode === 'keyword') {
                if (currentUrl.indexOf('q=') !== -1 && currentUrl.indexOf(item.val) !== -1) {
                    redirectToBlockPage();
                    return;
                }
            }
        }

        // 2. Check timed rules — need daily usage plus the pomodoro mirror
        if (timedRules.length > 0) {
            chrome.storage.local.get(['dailyUsage', 'pomodoro'], function (localRes) {
                var dailyUsage = localRes.dailyUsage || {};
                var today = getTodayKey();
                var todayUsage = dailyUsage[today] || {};
                // A running focus session blocks timed sites outright, whatever
                // today's usage is. The background state machine owns this flag.
                var strictNow = !!(localRes.pomodoro && localRes.pomodoro.strictNow);

                for (var k = 0; k < timedRules.length; k++) {
                    var timedRule = timedRules[k];
                    if (currentUrl.indexOf(timedRule.val) !== -1) {
                        var usedMs = todayUsage[timedRule.val] || 0;
                        var limitMs = (timedRule.limitMin || 30) * 60 * 1000;
                        if (strictNow || usedMs >= limitMs) {
                            redirectToBlockPage();
                            return;
                        }
                    }
                }
            });
        }
    });
}

// Run immediately when page loads
checkAndBlock();

// Also check on URL changes (SPA navigation)
window.addEventListener('popstate', checkAndBlock);
window.addEventListener('hashchange', checkAndBlock);
