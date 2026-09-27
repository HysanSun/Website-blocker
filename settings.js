// ============================================================
// settings.js — Settings page logic for Website Blocker v2.0
// ============================================================

const backBtn = document.getElementById('back-btn');
const rulesList = document.getElementById('rules-list');
const domainInput = document.getElementById('domain-input');
const typeSelect = document.getElementById('type-select');
const limitGroup = document.getElementById('limit-group');
const limitInput = document.getElementById('limit-input');
const addRuleBtn = document.getElementById('add-rule-btn');
const toast = document.getElementById('toast');

// ============================================================
// 1. HELPERS
// ============================================================
function getTodayKey() {
    return new Date().toLocaleDateString('zh-CN');
}

function showToast(text, isError) {
    toast.textContent = text;
    toast.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(function () { toast.className = 'toast'; }, 2500);
}

function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================
// 2. TOGGLE LIMIT INPUT VISIBILITY
// ============================================================
typeSelect.addEventListener('change', function () {
    limitGroup.style.display = (typeSelect.value === 'timed') ? 'flex' : 'none';
});

// ============================================================
// 3. RENDER RULES
// ============================================================
function loadAndRender() {
    // Fetch rules and daily usage in parallel
    var rulesDone = false;
    var usageDone = false;
    var rules = [];
    var dailyUsage = {};

    chrome.runtime.sendMessage({ action: 'getRules' }, function (rulesRes) {
        rules = (rulesRes && rulesRes.success) ? rulesRes.rules : [];
        rulesDone = true;
        if (usageDone) doRender();
    });

    chrome.runtime.sendMessage({ action: 'getDailyUsage' }, function (usageRes) {
        dailyUsage = (usageRes && usageRes.success) ? usageRes.dailyUsage : {};
        usageDone = true;
        if (rulesDone) doRender();
    });

    function doRender() {
        var today = getTodayKey();
        var todayUsage = dailyUsage[today] || {};

        if (rules.length === 0) {
            rulesList.innerHTML =
                '<div class="empty-state">' +
                '<div class="icon">&#128683;</div>' +
                '<p>No rules configured yet.<br>Add your first rule below.</p>' +
                '</div>';
            return;
        }

        var html = '';
        rules.forEach(function (rule) {
            var isTimed = rule.type === 'timed';
            var usedMs = todayUsage[rule.val] || 0;
            var limitMs = (rule.limitMin || 30) * 60 * 1000;
            var usedMin = Math.floor(usedMs / 60000);
            var limitMin = rule.limitMin || 30;
            var pct = Math.min(100, Math.round((usedMs / limitMs) * 100));
            var isExceeded = usedMs >= limitMs;

            html += '<div class="rule-item">';
            html += '<span class="rule-type-badge ' + (isTimed ? 'badge-timed' : 'badge-block') + '">' +
                    (isTimed ? 'Timed' : 'Blocked') + '</span>';
            html += '<span class="rule-domain">' + escapeHtml(rule.val) + '</span>';

            if (isTimed) {
                html += '<span class="rule-limit">' + limitMin + ' min/day</span>';
            } else {
                html += '<span class="rule-limit">Always</span>';
            }

            html += '<button class="rule-delete-btn" data-val="' + escapeHtml(rule.val) + '">Remove</button>';

            // Usage progress bar for timed rules
            if (isTimed) {
                var barClass = 'normal';
                if (isExceeded) barClass = 'exceeded';
                else if (pct > 75) barClass = 'warning';

                html += '<div class="usage-row">';
                html += '<div class="usage-bar-wrap"><div class="usage-bar-fill ' + barClass + '" style="width:' + pct + '%"></div></div>';
                html += '<span class="usage-text' + (isExceeded ? ' exceeded' : '') + '">';
                html += isExceeded ? 'LIMIT REACHED' : (usedMin + '/' + limitMin + ' min used');
                html += '</span></div>';
            }

            html += '</div>';
        });

        rulesList.innerHTML = html;

        // Attach delete handlers
        var deleteBtns = document.querySelectorAll('.rule-delete-btn');
        for (var i = 0; i < deleteBtns.length; i++) {
            deleteBtns[i].addEventListener('click', function () {
                deleteRule(this.dataset.val);
            });
        }
    }
}

// ============================================================
// 4. DELETE RULE
// ============================================================
function deleteRule(val) {
    chrome.runtime.sendMessage({ action: 'getRules' }, function (rulesRes) {
        if (!rulesRes || !rulesRes.success) {
            showToast('Failed to load rules', true);
            return;
        }

        var rules = rulesRes.rules || [];
        var updated = rules.filter(function (r) { return r.val !== val; });

        chrome.runtime.sendMessage({ action: 'saveRules', rules: updated }, function (saveRes) {
            if (!saveRes || !saveRes.success) {
                showToast('Failed to remove rule', true);
                return;
            }
            showToast('Removed: ' + val);
            loadAndRender();
        });
    });
}

// ============================================================
// 5. ADD RULE
// ============================================================
addRuleBtn.addEventListener('click', function () {
    var input = domainInput.value.trim().toLowerCase();
    var type = typeSelect.value;
    var limitMin = parseInt(limitInput.value) || 30;

    if (!input) {
        showToast('Enter a domain or keyword', true);
        return;
    }

    // Sanitize: remove protocol, path, and www prefix
    var cleanVal = input
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/^www\./, '');

    chrome.runtime.sendMessage({ action: 'getRules' }, function (rulesRes) {
        if (!rulesRes || !rulesRes.success) {
            showToast('Failed to load rules', true);
            return;
        }

        var rules = rulesRes.rules || [];

        // Check duplicate
        for (var i = 0; i < rules.length; i++) {
            if (rules[i].val === cleanVal) {
                showToast('"' + cleanVal + '" is already in your rules', true);
                return;
            }
        }

        var newRule = {
            val: cleanVal,
            mode: 'website',
            type: type
        };
        if (type === 'timed') {
            newRule.limitMin = limitMin;
        }

        rules.push(newRule);

        chrome.runtime.sendMessage({ action: 'saveRules', rules: rules }, function (saveRes) {
            if (!saveRes || !saveRes.success) {
                showToast('Failed to add rule', true);
                return;
            }

            var label = type === 'timed' ? 'Timed: ' + limitMin + ' min/day' : 'Complete Block';
            showToast('Added: ' + cleanVal + ' (' + label + ')');
            domainInput.value = '';
            loadAndRender();
        });
    });
});

// ============================================================
// 6. BACK BUTTON
// ============================================================
backBtn.addEventListener('click', function () {
    window.close();
});

// ============================================================
// 7. INIT
// ============================================================
loadAndRender();

// Refresh usage every 30 seconds
setInterval(loadAndRender, 30000);
