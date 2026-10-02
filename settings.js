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
const exportDataBtn = document.getElementById('export-btn');
const importDataBtn = document.getElementById('import-btn');
const importFile = document.getElementById('import-file');
const windowToggle = document.getElementById('window-toggle');
const windowGroup = document.getElementById('window-group');
const windowDays = document.getElementById('window-days');
const windowFrom = document.getElementById('window-from');
const windowTo = document.getElementById('window-to');
const unlockList = document.getElementById('unlock-list');

// Day picker for a rule's optional time window. Mirrors the rule window in
// background.js (`ruleWindowActive`), where 0 is Sunday.
var TEMP_UNLOCK_MIN = 30;
var DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var DEFAULT_DAYS = [1, 2, 3, 4, 5];

DAY_LABELS.forEach(function (label, index) {
    var wrap = document.createElement('label');
    wrap.className = 'day-check';
    wrap.setAttribute('data-day', String(index));
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(index);
    wrap.appendChild(box);
    wrap.appendChild(document.createTextNode(label));
    wrap.addEventListener('click', function () { setTimeout(paintDays, 0); });
    windowDays.appendChild(wrap);
});

function paintDays() {
    var boxes = windowDays.querySelectorAll('input');
    for (var i = 0; i < boxes.length; i++) {
        boxes[i].parentNode.className = 'day-check' + (boxes[i].checked ? ' on' : '');
    }
}

function selectedDays() {
    var out = [];
    var boxes = windowDays.querySelectorAll('input');
    for (var i = 0; i < boxes.length; i++) { if (boxes[i].checked) out.push(Number(boxes[i].value)); }
    return out;
}

function setDays(days) {
    var want = (days && days.length) ? days : DEFAULT_DAYS;
    var boxes = windowDays.querySelectorAll('input');
    for (var i = 0; i < boxes.length; i++) {
        boxes[i].checked = want.indexOf(Number(boxes[i].value)) !== -1;
    }
    paintDays();
}

// Readable form of a rule's window, or '' when it has none.
function windowText(win) {
    if (!win || typeof win !== 'object') return '';
    var from = win.from || '';
    var to = win.to || '';
    if (!from || !to) return '';
    var days = (win.days && win.days.length) ? win.days.slice().sort() : null;
    var dayText = 'Every day';
    if (days && days.length === 7) dayText = 'Every day';
    else if (days) {
        dayText = days.map(function (d) { return DAY_LABELS[d] || '?'; }).join(' ');
    }
    return dayText + ' ' + from + '\u2013' + to;
}

// Mirrors ruleWindowActive() in background.js. A wrong grey tint is the worst
// thing that happens if the two ever drift; enforcement is decided by the
// worker, not here.
function isWindowActive(rule) {
    var win = rule && rule.window;
    if (!win || typeof win !== 'object') return true;
    var from = parseClock(win.from);
    var to = parseClock(win.to);
    if (from === null || to === null) return true;
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var crosses = from > to;
    var inRange = crosses ? (nowMin >= from || nowMin < to) : (nowMin >= from && nowMin < to);
    var days = (win.days && win.days.length) ? win.days : null;
    if (!days) return inRange;
    var day = now.getDay();
    var belongsTo = (crosses && nowMin < to) ? (day + 6) % 7 : day;
    return inRange && days.indexOf(belongsTo) !== -1;
}

function parseClock(text) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text).trim());
    if (!m) return null;
    var h = Number(m[1]);
    var mm = Number(m[2]);
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
}

function readWindowFromForm() {
    if (!windowToggle.checked) return null;
    var days = selectedDays();
    return {
        days: days.length ? days : DEFAULT_DAYS.slice(),
        from: windowFrom.value || '09:00',
        to: windowTo.value || '17:00'
    };
}

function setWindowInForm(win) {
    var on = !!(win && typeof win === 'object');
    windowToggle.checked = on;
    windowGroup.hidden = !on;
    setDays(on ? win.days : DEFAULT_DAYS);
    windowFrom.value = (on && win.from) || '09:00';
    windowTo.value = (on && win.to) || '17:00';
}

windowToggle.addEventListener('change', function () {
    windowGroup.hidden = !windowToggle.checked;
});

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
    var exception = isExceptionVal(domainInput.value);
    limitGroup.style.display = (typeSelect.value === 'timed' && !exception) ? 'flex' : 'none';
    // A window says when a block applies; an exception never blocks, so the
    // whole control disappears with it.
    var toggleRow = windowToggle.closest('.form-row');
    if (toggleRow) toggleRow.style.display = exception ? 'none' : 'flex';
    if (exception) { windowToggle.checked = false; windowGroup.hidden = true; }
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
        setWindowInForm(rule.window);
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
    setWindowInForm(null);
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
            var winText = windowText(rule.window);
            var winOff = !!winText && !isWindowActive(rule);

            html += '<div class="rule-item' + (winOff ? ' is-off' : '') + '">';
            html += '<span class="rule-type-badge ' + badgeClass + '">' + badgeText + '</span>';
            html += '<span class="rule-domain">' + escapeHtml(rule.val) + '</span>';

            if (isTimed) {
                html += '<span class="rule-limit">' + limitMin + ' min/day</span>';
            } else if (exception) {
                html += '<span class="rule-limit">Never blocked</span>';
            } else {
                html += '<span class="rule-limit">Always</span>';
            }

            html += '<span class="rule-actions">';
            html += '<button class="rule-edit-btn" data-val="' + escapeHtml(rule.val) + '">Edit</button>';
            if (!exception) {
                html += '<button class="rule-unlock-btn" data-val="' + escapeHtml(rule.val) +
                    '" title="Allow this site for ' + TEMP_UNLOCK_MIN + ' minutes">Unlock</button>';
            }
            html += '<button class="rule-delete-btn" data-val="' + escapeHtml(rule.val) + '">Remove</button>';
            html += '</span>';

            if (winText) {
                html += '<div class="rule-window">' + (winOff ? 'Outside its hours — not enforced now. ' : 'During ') +
                    escapeHtml(winText) + '</div>';
            }

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
        renderUnlocks();

        var editBtns = document.querySelectorAll('.rule-edit-btn');
        for (var i = 0; i < editBtns.length; i++) {
            editBtns[i].addEventListener('click', function () { beginEdit(this.dataset.val); });
        }

        var unlockBtns = document.querySelectorAll('.rule-unlock-btn');
        for (var k = 0; k < unlockBtns.length; k++) {
            unlockBtns[k].addEventListener('click', function () { requestUnlock(this.dataset.val); });
        }

        var deleteBtns = document.querySelectorAll('.rule-delete-btn');
        for (var j = 0; j < deleteBtns.length; j++) {
            deleteBtns[j].addEventListener('click', function () { deleteRule(this.dataset.val); });
        }
    }
}

// ============================================================
// 3b. TEMPORARY UNLOCKS
// ============================================================
// The escape hatch that does not require deleting the extension: an allow rule
// with an expiry, in its own rule-id band on the worker. Same mechanism as a
// '!' exception, so there is only ever one kind of "let me through".
function unlockLeftText(until) {
    var left = Math.max(0, until - Date.now());
    return Math.max(1, Math.ceil(left / 60000)) + ' min left';
}

function renderUnlocks() {
    if (!unlockList) return;
    chrome.runtime.sendMessage({ action: 'getTempUnlocks' }, function (res) {
        var unlocks = (res && res.success && res.tempUnlocks) ? res.tempUnlocks : [];
        if (!unlocks.length) { unlockList.innerHTML = ''; return; }
        var html = '<div class="rule-limit" style="margin-bottom:6px;">Open right now</div>';
        unlocks.sort(function (a, b) { return a.until - b.until; });
        unlocks.forEach(function (u) {
            html += '<div class="unlock-item">';
            html += '<span class="unlock-host">' + escapeHtml(u.host) + '</span>';
            html += '<span>' + unlockLeftText(u.until) + '</span>';
            html += '<button data-val="' + escapeHtml(u.host) + '">Lock now</button>';
            html += '</div>';
        });
        unlockList.innerHTML = html;
        var btns = unlockList.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
            btns[i].addEventListener('click', function () { revokeUnlock(this.dataset.val); });
        }
    });
}

// A worker that has never heard of an action answers "Unknown action". That is
// not the action failing: it is a page that is newer than the service worker,
// which is what an unpacked extension looks like after the files on disk are
// updated but chrome://extensions was not reloaded. Saying "Could not unlock"
// there sends the user looking for a bug in the feature that is not there.
function staleWorker(res) {
    return !!(res && res.error === 'Unknown action');
}

function requestUnlock(val) {
    chrome.runtime.sendMessage({ action: 'tempUnlock', val: val, minutes: TEMP_UNLOCK_MIN },
        function (res) {
            if (!res || !res.success) {
                showToast(staleWorker(res)
                    ? 'Reload the extension at chrome://extensions - this page is newer than its worker'
                    : 'Could not unlock ' + val, true);
                return;
            }
            showToast('Unlocked for ' + TEMP_UNLOCK_MIN + ' min: ' + val);
            loadAndRender();
        });
}

function revokeUnlock(val) {
    chrome.runtime.sendMessage({ action: 'tempUnlock', val: val, minutes: 0 }, function (res) {
        if (!res || !res.success) {
            showToast(staleWorker(res)
                ? 'Reload the extension at chrome://extensions - this page is newer than its worker'
                : 'Could not lock ' + val, true);
            return;
        }
        showToast('Locked again: ' + val);
        loadAndRender();
    });
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
            var win = readWindowFromForm();
            if (win) newRule.window = win;
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
            if (!exception && newRule.window) label += ', ' + windowText(newRule.window);
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
// 7. BACKUP — export / import everything
// ============================================================
// The product's own rule is that the only way to unlock a blocked site is to
// remove the extension, which also throws every rule, task and streak away.
// This is the safety net.
function exportData() {
    Promise.all([
        new Promise(function (r) { chrome.storage.sync.get(null, r); }),
        new Promise(function (r) { chrome.storage.local.get(null, r); })
    ]).then(function (parts) {
        var payload = {
            v: 1,
            app: 'website-blocker',
            exportedAt: new Date().toISOString(),
            extensionVersion: chrome.runtime.getManifest().version,
            sync: parts[0] || {},
            local: parts[1] || {}
        };
        var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'website-blocker-backup.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        showToast('Exported your rules, tasks and streak');
    });
}

function looksLikeBackup(payload) {
    return !!(payload && typeof payload === 'object' &&
        (payload.sync && typeof payload.sync === 'object' ||
         payload.local && typeof payload.local === 'object'));
}

function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
        var payload;
        try {
            payload = JSON.parse(String(reader.result));
        } catch (e) {
            showToast('That file is not valid JSON', true);
            return;
        }
        if (!looksLikeBackup(payload)) {
            showToast('That file is not a Website Blocker backup', true);
            return;
        }
        var writes = [];
        if (payload.sync && typeof payload.sync === 'object') {
            writes.push(new Promise(function (r) { chrome.storage.sync.set(payload.sync, r); }));
        }
        if (payload.local && typeof payload.local === 'object') {
            writes.push(new Promise(function (r) { chrome.storage.local.set(payload.local, r); }));
        }
        Promise.all(writes).then(function () {
            return new Promise(function (r) { chrome.runtime.sendMessage({ action: 'syncRules' }, r); });
        }).then(function () {
            showToast('Imported: your rules, tasks and streak were replaced');
            loadAndRender();
            renderStreak();
        });
    };
    reader.readAsText(file);
}

if (exportDataBtn) exportDataBtn.addEventListener('click', exportData);
if (importDataBtn && importFile) {
    importDataBtn.addEventListener('click', function () { importFile.click(); });
    importFile.addEventListener('change', function () {
        if (importFile.files && importFile.files[0]) importData(importFile.files[0]);
        importFile.value = '';
    });
}

// ============================================================
// 8. BACK BUTTON
// ============================================================
backBtn.addEventListener('click', function () {
    window.close();
});

// ============================================================
// 9. INIT
// ============================================================
cancelEdit();
loadAndRender();
renderStreak();

// Refresh usage every 30 seconds
setInterval(loadAndRender, 30000);