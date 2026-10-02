// ============================================================
// streaks.js — Popup UI logic for Website Blocker v2.0
// ============================================================

const urlInput = document.getElementById('url-input');
const modeSelect = document.getElementById('block-mode');
const addBtn = document.getElementById('add-site');
const display = document.getElementById('streak-display');
const settingsBtn = document.getElementById('settings-btn');
const dailyUsageSection = document.getElementById('daily-usage-section');
const dailyUsageList = document.getElementById('daily-usage-list');

// ============================================================
// 1. VERSION LABEL + INTEGRITY CHECK (Popup Listener)
// ============================================================
// The page used to hard-code "v2.0" in the markup, so it kept claiming 2.0
// while the extension moved on. The manifest is the one source of truth.
function showVersion() {
    var label = document.getElementById('version-label');
    if (!label || !chrome.runtime.getManifest) return;
    var version = chrome.runtime.getManifest().version;
    label.textContent = version ? 'v' + version : '';
}
function checkIntegrity() {
    chrome.storage.local.get(['needsAlert'], (res) => {
        if (res.needsAlert) {
            // The one message that explains why the number above went back to
            // zero, so it stays up long enough to read. It used to be a native
            // alert(), which is the coldest possible way to say it.
            showHint('Strike detected: permissions were changed or the extension was ' +
                'switched off, so the streak is back to 0.', 'error', 9000);
            chrome.storage.local.set({ needsAlert: false });
        }
    });
}

// ============================================================
// 2. STREAK UI LOGIC
// ============================================================
function resetStreak() {
    const now = new Date().getTime();
    chrome.storage.local.set({ startDate: now, lastHeartbeat: now }, () => {
        updateStreak();
    });
}

function updateStreak() {
    chrome.storage.local.get(['startDate'], (res) => {
        if (!res.startDate) {
            resetStreak();
        } else {
            const diff = new Date().getTime() - res.startDate;
            display.innerText = Math.floor(diff / (1000 * 60 * 60 * 24));
        }
    });
}

// ============================================================
// 3. DAILY USAGE DISPLAY
// ============================================================
function getTodayKey() {
    return new Date().toLocaleDateString('zh-CN');
}

function renderDailyUsage() {
    chrome.runtime.sendMessage({ action: 'getRules' }, (rulesRes) => {
        if (!rulesRes || !rulesRes.success) return;

        const rules = rulesRes.rules || [];
        const timedRules = rules.filter(r => r.type === 'timed');

        if (timedRules.length === 0) {
            dailyUsageSection.style.display = 'none';
            return;
        }

        dailyUsageSection.style.display = 'block';

        chrome.runtime.sendMessage({ action: 'getDailyUsage' }, (usageRes) => {
            if (!usageRes || !usageRes.success) return;

            const dailyUsage = usageRes.dailyUsage || {};
            const today = getTodayKey();
            const todayUsage = dailyUsage[today] || {};

            let html = '';
            timedRules.forEach(rule => {
                const usedMs = todayUsage[rule.val] || 0;
                const limitMs = (rule.limitMin || 30) * 60 * 1000;
                const usedMin = Math.floor(usedMs / 60000);
                const limitMin = rule.limitMin || 30;
                const pct = Math.min(100, Math.round((usedMs / limitMs) * 100));
                const isExceeded = usedMs >= limitMs;

                let barClass = 'normal';
                if (isExceeded) barClass = 'exceeded';
                else if (pct > 75) barClass = 'warning';

                html += `
                    <div class="usage-item">
                        <span class="usage-domain" title="${rule.val}">${rule.val}</span>
                        <div class="usage-bar-wrap">
                            <div class="usage-bar-fill ${barClass}" style="width:${pct}%"></div>
                        </div>
                        <span class="usage-text ${isExceeded ? 'exceeded' : ''}">${usedMin}/${limitMin} min</span>
                    </div>
                `;
            });

            dailyUsageList.innerHTML = html;
        });
    });
}

// ============================================================
// 4. UI FEEDBACK
// ============================================================
// One channel for the whole extension (ui.js). The popup used to have its own
// fixed-height line whose colour was picked here.
function showHint(text, type, ms) {
    if (window.WB) WB.toast(text, type === 'success' ? 'success' : 'error', ms);
}

// ============================================================
// 5. BLOCKING ENGINE — quick add (always type=block from popup)
// ============================================================
addBtn.addEventListener('click', () => {
    const input = urlInput.value.trim().toLowerCase();
    const mode = modeSelect.value;
    if (!input) return;

    chrome.runtime.sendMessage({ action: 'getRules' }, (res) => {
        if (!res || !res.success) {
            showHint('Error reading rules', 'error');
            return;
        }
        const items = res.rules || [];

        if (items.some(item => item.val === input)) {
            showHint('Already strictly blocked!', 'error');
            return;
        }

        // From popup, always add as complete block (timed rules via Settings)
        items.push({ val: input, mode: mode, type: 'block' });

        chrome.runtime.sendMessage({ action: 'saveRules', rules: items }, (saveRes) => {
            if (saveRes && saveRes.success) {
                showHint(`Locked: ${input}`, 'success');
                urlInput.value = '';
                renderDailyUsage();
            } else {
                showHint('Error: Failed to save', 'error');
            }
        });
    });
});

// ============================================================
// 6. SETTINGS BUTTON — open settings page
// ============================================================
settingsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.windows.create({
        url: chrome.runtime.getURL('settings.html'),
        type: 'popup',
        width: 500,
        height: 600
    });
});


// ============================================================
// 8. INIT — run on popup open
// ============================================================
showVersion();
checkIntegrity();
updateStreak();
renderDailyUsage();
