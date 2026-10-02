// ============================================================
// settings.js — Settings page logic for Website Blocker
// ============================================================

const backBtn = document.getElementById('back-btn');
const rulesList = document.getElementById('rules-list');
const domainInput = document.getElementById('domain-input');
const typeSelect = document.getElementById('type-select');
const limitGroup = document.getElementById('limit-group');
const limitInput = document.getElementById('limit-input');
const addRuleBtn = document.getElementById('add-rule-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');
const resetStreakBtn = document.getElementById('reset-btn');
const streakNote = document.getElementById('streak-note');

// The value of the rule currently loaded into the form, or null when the form
// is adding a new one. Editing reuses the same fields instead of making the
// user delete the rule and retype it from memory.
let editingVal = null;

// ============================================================
// 1. HELPERS
// ============================================================
function getTodayKey() {
    return new Date().toLocaleDateString('zh-CN');
}

function showToast(text, isError) {
    if (window.WB) WB.toast(text, isError ? 'error' : 'success');
}

function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// A value starting with '!' is an exception: never block this host or anything
// under it. It lives in the same list as the rules, so the list has to say so
// instead of showing it as one more blocked site.
function isExceptionVal(val) {
    return String(val == null ? '' : val).trim().charAt(0) === '!';
}

// ============================================================
// 2. FORM STATE
// ============================================================
function syncLimitVisibility() {
    limitGroup.style.display = (typeSelect.value === 'timed' && !isExceptionVal(domainInput.value))
        ? 'flex' : 'none';
}

typeSelect.addEventListener('change', syncLimitVisibility);
domainInput.addEventListener('input', syncLimitVisibility);

function beginEdit(val) {
    chrome.runtime.sendMessage({ action: 'getRules' }, function (res) {
        var rules = (res && res.success) ? res.rules : [];
        var rule = null;
        for (var i = 0; i < rules.length; i++) {
            if (rules[i] && rules[i].val === val) rule = rules[i];
        }
        if (!rule) return;

        editingVal = val;
        domainInput.value = rule.val;
        typeSelect.value = (rule.type === 'timed') ? 'timed' : 'block';
        limitInput.value = rule.limitMin || 30;
        syncLimitVisibility();
        addRuleBtn.textContent = 'Save changes';
        cancelEditBtn.hidden = false;
        domainInput.focus();
        domainInput.select();
    });
}

function cancelEdit() {
    editingVal = null;
    domainInput.value = '';
    typeSelect.value = 'timed';
    limitInput.value = 30;
    syncLimitVisibility();
    addRuleBtn.textContent = 'Add Rule';
    cancelEditBtn.hidden = true;
}

// ============================================================
// 3. RENDER RULES
// ============================================================
function loadAndRender() {
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
            var exception = isExceptionVal(rule.val);
            var isTimed = !exception && rule.type === 'timed';
            var usedMs = todayUsage[rule.val] || 0;
            var limitMin = rule.limitMin || 30;
            var limitMs = limitMin * 60 * 1000;
            var usedMin = Math.floor(usedMs / 60000);
            var pct = Math.min(100, Math.round((usedMs / limitMs) * 100));
            var isExceeded = usedMs >= limitMs;

            var badgeClass = exception ? 'badge-exception' : (isTimed ? 'badge-timed' : 'badge-block');
            var badgeText = exception ? 'Exception' : (isTimed ? 'Timed' : 'Blocked');

            html += '<div class="rule-item">';
            html += '<span class="rule-type-badge ' + badgeClass + '">' + badgeText + '</span>';
            html += '<span class="rule-domain">' + escapeHtml(rule.val) + '</span>';

            if (isTimed) {
                html += '<span class="rule-limit">' + limitMin + ' min/day</span>';
            } else if (exception) {
                html += '<span class="rule-limit">Never blocked</span>';
            } else {
                html += '<span class="rule-limit">Always</span>';
            }

            html += '<button class="rule-edit-btn" data-val="' + escapeHtml(rule.val) + '">Edit</button>';
            html += '<button class="rule-delete-btn" data-val="' + escapeHtml(rule.val) + '">Remove</button>';

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

        var editBtns = document.querySelectorAll('.rule-edit-btn');
        for (var i = 0; i < editBtns.length; i++) {
            editBtns[i].addEventListener('click', function () { beginEdit(this.dataset.val); });
        }

        var deleteBtns = document.querySelectorAll('.rule-delete-btn');
        for (var j = 0; j < deleteBtns.length; j++) {
            deleteBtns[j].addEventListener('click', function () { deleteRule(this.dataset.val); });
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
        if (updated.length === rules.length) return;

        chrome.runtime.sendMessage({ action: 'saveRules', rules: updated }, function (saveRes) {
            if (!saveRes || !saveRes.success) {
                showToast('Failed to remove rule', true);
                return;
            }
            if (editingVal === val) cancelEdit();
            showToast('Removed: ' + val);
            loadAndRender();
        });
    });
}

// ============================================================
// 5. ADD / SAVE RULE
// ============================================================
addRuleBtn.addEventListener('click', function () {
    var input = domainInput.value.trim().toLowerCase();
    var type = typeSelect.value;
    var limitMin = parseInt(limitInput.value, 10) || 30;

    if (!input) {
        showToast('Enter a domain or keyword', true);
        return;
    }

    // Sanitize: remove protocol, path, and www prefix. The leading '!' of an
    // exception has to survive that, so it is peeled off first.
    var exception = isExceptionVal(input);
    var bare = exception ? input.slice(1).trim() : input;
    bare = bare
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/^www\./, '');
    if (!bare) {
        showToast('Enter a domain or keyword', true);
        return;
    }
    var cleanVal = exception ? '!' + bare : bare;

    chrome.runtime.sendMessage({ action: 'getRules' }, function (rulesRes) {
        if (!rulesRes || !rulesRes.success) {
            showToast('Failed to load rules', true);
            return;
        }

        var rules = rulesRes.rules || [];

        // A rename may not collide with a rule that is already there.
        for (var i = 0; i < rules.length; i++) {
            if (rules[i] && rules[i].val === cleanVal && cleanVal !== editingVal) {
                showToast('"' + cleanVal + '" is already in your rules', true);
                return;
            }
        }

        var newRule = { val: cleanVal, mode: 'website', type: 'block' };
        if (!exception) {
            newRule.type = type;
            if (type === 'timed') newRule.limitMin = limitMin;
        }

        var wasEditing = editingVal;
        var updated = rules.filter(function (r) { return r && r.val !== wasEditing; });
        updated.push(newRule);

        chrome.runtime.sendMessage({ action: 'saveRules', rules: updated }, function (saveRes) {
            if (!saveRes || !saveRes.success) {
                showToast('Failed to save rule', true);
                return;
            }
            var label = exception ? 'Exception' :
                (type === 'timed' ? 'Timed: ' + limitMin + ' min/day' : 'Complete Block');
            showToast((wasEditing ? 'Updated: ' : 'Added: ') + cleanVal + ' (' + label + ')');
            cancelEdit();
            loadAndRender();
        });
    });
});

cancelEditBtn.addEventListener('click', cancelEdit);

// ============================================================
// 6. FOCUS STREAK
// ============================================================
// The counter is on the popup; the button that zeroes it lives here, so it is
// no longer sitting one mis-click under the number it destroys.
function renderStreak() {
    if (!streakNote) return;
    chrome.storage.local.get(['startDate'], function (res) {
        if (!res.startDate) {
            streakNote.textContent = 'No streak yet.';
            return;
        }
        var days = Math.floor((Date.now() - res.startDate) / (1000 * 60 * 60 * 24));
        streakNote.textContent = 'The popup currently shows ' + days +
            ' day(s) since your last reset.';
    });
}

function resetStreak() {
    var now = Date.now();
    chrome.storage.local.set({ startDate: now, lastHeartbeat: now }, function () {
        showToast('Streak reset to 0');
        renderStreak();
    });
}

// A destructive action that cannot be undone asks twice instead of using a
// native confirm().
if (window.WB && resetStreakBtn) WB.armButton(resetStreakBtn, 'Click again to reset', resetStreak);

// ============================================================
// 7. BACK BUTTON
// ============================================================
backBtn.addEventListener('click', function () {
    window.close();
});

// ============================================================
// 8. INIT
// ============================================================
cancelEdit();
loadAndRender();
renderStreak();

// Refresh usage every 30 seconds
setInterval(loadAndRender, 30000);