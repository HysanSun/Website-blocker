// ============================================================
// Website Blocker v2.0 — Background Service Worker
// Features: heartbeat integrity, time-limited blocking, daily reset
// ============================================================

// --- Constants ---
const HEARTBEAT_INTERVAL_MIN = 1;
const TRACKING_INTERVAL_SEC = 60; // Chrome alarms minimum period is 1 minute
const TIMED_RULE_ID_OFFSET = 2000000;
const START_EVENT_GRACE_MS = 1500;            // let onStartup/onInstalled land before judging the streak
const HEARTBEAT_STALE_LOG_MS = 2 * 60 * 1000; // log a gap past this; never reset on it
const STORAGE_KEYS = {
  BLOCKED_ITEMS: 'blockedItems',
  DAILY_USAGE: 'dailyUsage',
  START_DATE: 'startDate',
  LAST_HEARTBEAT: 'lastHeartbeat',
  NEEDS_ALERT: 'needsAlert'
};
// Liveness marker in storage.session: it rides out service-worker suspension
// and system sleep, but is wiped when the extension is disabled/reloaded or
// the browser restarts.
const SW_ALIVE_KEY = 'swAlive';

// ============================================================
// 1. DATA MIGRATION — upgrade old rule format on install/startup
// ============================================================
function migrateData() {
  chrome.storage.sync.get([STORAGE_KEYS.BLOCKED_ITEMS], (res) => {
    const items = res[STORAGE_KEYS.BLOCKED_ITEMS] || [];
    let changed = false;
    const migrated = items.map(item => {
      if (!item.type) {
        changed = true;
        return { val: item.val, mode: item.mode, type: 'block' };
      }
      return item;
    });
    if (changed) {
      chrome.storage.sync.set({ [STORAGE_KEYS.BLOCKED_ITEMS]: migrated }, () => {
        console.log('[Blocker] Migrated', items.length, 'rules to v2 format');
        syncAllRules();
      });
    }
  });
}

// ============================================================
// 2. RULE SYNC — keep declarativeNetRequest in sync with storage
// ============================================================
async function syncAllRules() {
  try {
    // Remove all existing dynamic rules
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map(r => r.id);
    if (existingIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existingIds });
    }

    // Get current state: blocked items + daily usage
    const [syncData, localData] = await Promise.all([
      chrome.storage.sync.get([STORAGE_KEYS.BLOCKED_ITEMS]),
      chrome.storage.local.get([STORAGE_KEYS.DAILY_USAGE])
    ]);

    const items = syncData[STORAGE_KEYS.BLOCKED_ITEMS] || [];
    const today = getTodayKey();
    const dailyUsage = localData[STORAGE_KEYS.DAILY_USAGE] || {};

    const rulesToAdd = [];
    let ruleIndex = 0;

    items.forEach((item, idx) => {
      if (item.type === 'block') {
        // Complete block — always register DNR rule
        const filterPattern = (item.mode === 'website')
          ? `*://*.${item.val}/*`
          : `*://*/*?*q=*${item.val}*`;

        rulesToAdd.push({
          id: ruleIndex + 1,
          priority: 10,
          action: { type: 'redirect', redirect: { extensionPath: '/blockpage.html' } },
          condition: {
            urlFilter: filterPattern,
            resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'xmlhttprequest', 'other']
          }
        });
        ruleIndex++;
      } else if (item.type === 'timed') {
        // Time-limited — only register DNR rule if daily limit exceeded
        const usedToday = (dailyUsage[today] && dailyUsage[today][item.val])
          ? dailyUsage[today][item.val]
          : 0;
        const limitMs = (item.limitMin || 30) * 60 * 1000;

        if (usedToday >= limitMs) {
          const filterPattern = `*://*.${item.val}/*`;
          rulesToAdd.push({
            id: TIMED_RULE_ID_OFFSET + idx,
            priority: 10,
            action: { type: 'redirect', redirect: { extensionPath: '/blockpage.html' } },
            condition: {
              urlFilter: filterPattern,
              resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'xmlhttprequest', 'other']
            }
          });
        }
      }
    });

    if (rulesToAdd.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rulesToAdd });
    }
    console.log('[Blocker] Synced', rulesToAdd.length, 'DNR rules');
  } catch (err) {
    console.error('[Blocker] syncAllRules error:', err);
  }
}

// ============================================================
// 3. TIME TRACKING ENGINE
// ============================================================
function getTodayKey() {
  // Use locale date string for timezone-aware day boundary
  return new Date().toLocaleDateString('zh-CN');
}

let activeTimedDomain = null;

async function trackActiveTab() {
  try {
    // 3a. Check if date changed → reset if needed
    const today = getTodayKey();
    const { [STORAGE_KEYS.DAILY_USAGE]: storedUsage } = await chrome.storage.local.get([STORAGE_KEYS.DAILY_USAGE]);
    const dailyUsage = storedUsage || {};

    // Ensure today's entry exists
    if (!dailyUsage[today]) {
      dailyUsage[today] = {};
      // New day — sync rules to remove expired timed blocks
      await syncAllRules();
    }

    // Clean up old dates (keep only yesterday + today, max 2 entries)
    const keys = Object.keys(dailyUsage).sort();
    while (keys.length > 2) {
      delete dailyUsage[keys.shift()];
    }

    // 3b. Get active tab
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) {
      activeTimedDomain = null;
      return;
    }

    // 3c. Check if active tab matches any timed rule
    const { [STORAGE_KEYS.BLOCKED_ITEMS]: storedItems } = await chrome.storage.sync.get([STORAGE_KEYS.BLOCKED_ITEMS]);
    const items = storedItems || [];
    const urlLower = tab.url.toLowerCase();

    let matchedDomain = null;
    let matchedLimitMin = 30;

    for (const item of items) {
      if (item.type === 'timed' && item.mode === 'website') {
        if (urlLower.includes(item.val)) {
          matchedDomain = item.val;
          matchedLimitMin = item.limitMin || 30;
          break;
        }
      }
    }

    // 3d. Accumulate time if on a timed site
    if (matchedDomain) {
      activeTimedDomain = matchedDomain;
      const prevMs = dailyUsage[today][matchedDomain] || 0;
      dailyUsage[today][matchedDomain] = prevMs + (TRACKING_INTERVAL_SEC * 1000);

      await chrome.storage.local.set({ [STORAGE_KEYS.DAILY_USAGE]: dailyUsage });

      const limitMs = matchedLimitMin * 60 * 1000;
      const newMs = dailyUsage[today][matchedDomain];

      // 3e. Check if just exceeded limit → enforce
      if (prevMs < limitMs && newMs >= limitMs) {
        console.log('[Blocker] Time limit reached for', matchedDomain);
        await enforceTimeLimit(matchedDomain, matchedLimitMin);
      }

      // 3f. Warning at 5 minutes remaining
      const remainingMs = limitMs - newMs;
      if (remainingMs > 0 && remainingMs <= 5 * 60 * 1000 && prevMs > limitMs - 6 * 60 * 1000) {
        const remainingMin = Math.ceil(remainingMs / 60000);
        showWarningNotification(matchedDomain, remainingMin);
      }
    } else {
      activeTimedDomain = null;
    }
  } catch (err) {
    // Tab query can fail if no window is focused — non-critical
    console.debug('[Blocker] trackActiveTab skipped:', err.message);
  }
}

async function enforceTimeLimit(domain, limitMin) {
  // 1. Add DNR rule to block this domain
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const timedRuleIds = existingRules
    .filter(r => r.id >= TIMED_RULE_ID_OFFSET)
    .map(r => r.id);

  // Find the right ID for this domain
  const { [STORAGE_KEYS.BLOCKED_ITEMS]: storedItems } = await chrome.storage.sync.get([STORAGE_KEYS.BLOCKED_ITEMS]);
  const items = storedItems || [];
  const itemIdx = items.findIndex(item => item.val === domain && item.type === 'timed');
  const ruleId = (itemIdx >= 0) ? TIMED_RULE_ID_OFFSET + itemIdx : TIMED_RULE_ID_OFFSET + Math.floor(Math.random() * 10000);

  // Remove existing timed rule for this domain if any
  if (timedRuleIds.includes(ruleId)) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
  }

  // Add block rule
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
      id: ruleId,
      priority: 10,
      action: { type: 'redirect', redirect: { extensionPath: '/blockpage.html' } },
      condition: {
        urlFilter: `*://*.${domain}/*`,
        resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'xmlhttprequest', 'other']
      }
    }]
  });

  // 2. Redirect active tab if it's on this domain
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.url && tab.url.toLowerCase().includes(domain)) {
      await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL('blockpage.html') });
    }
  } catch (e) {
    console.debug('[Blocker] Could not redirect active tab:', e.message);
  }

  console.log('[Blocker] Enforced time limit for', domain, '(', limitMin, 'min)');
}

function showWarningNotification(domain, remainingMin) {
  // Use a simple approach: set a flag that the popup can read
  // Chrome notifications require 'notifications' permission
  // For now, we log to console and the popup can show it
  console.log('[Blocker] WARNING:', domain, 'has only', remainingMin, 'min remaining today');
}

// ============================================================
// 4. DAILY RESET — fires at 00:01 each day
// ============================================================
async function resetDailyLimits() {
  console.log('[Blocker] Running daily reset...');
  const today = getTodayKey();

  // Clean daily usage — keep only today
  const { [STORAGE_KEYS.DAILY_USAGE]: storedUsage } = await chrome.storage.local.get([STORAGE_KEYS.DAILY_USAGE]);
  const dailyUsage = storedUsage || {};
  // Remove all entries except today (in case today's key is already there)
  Object.keys(dailyUsage).forEach(key => {
    if (key !== today) delete dailyUsage[key];
  });
  dailyUsage[today] = {};
  await chrome.storage.local.set({ [STORAGE_KEYS.DAILY_USAGE]: dailyUsage });

  // Remove all timed DNR block rules
  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const timedIds = existingRules
    .filter(r => r.id >= TIMED_RULE_ID_OFFSET)
    .map(r => r.id);
  if (timedIds.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: timedIds });
  }

  console.log('[Blocker] Daily reset complete. Removed', timedIds.length, 'timed rules.');
}

// Calculate ms until next 00:01
function getMsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 1, 0, 0); // 00:01 next day
  return midnight.getTime() - now.getTime();
}

// ============================================================
// 5. HEARTBEAT & STREAK INTEGRITY
//
// The streak (startDate) is broken by exactly two things:
//   a) the extension being switched off and back on, or
//   b) the user pressing "Reset Streak" in the popup.
//
// Everything else must leave it alone. The old code reset whenever the gap
// since the last heartbeat exceeded 61s while the alarm fired every 60s, so
// ordinary alarm jitter, service-worker recycling, sleep and every browser
// restart wiped the streak — the day counter could never reach 1.
// ============================================================
chrome.alarms.create('heartbeat', { periodInMinutes: HEARTBEAT_INTERVAL_MIN });

// Liveness breadcrumb only. Logs a suspicious gap for diagnostics but
// deliberately never touches startDate.
async function heartbeat() {
  const now = Date.now();
  const { [STORAGE_KEYS.LAST_HEARTBEAT]: lastHb } = await chrome.storage.local.get([STORAGE_KEYS.LAST_HEARTBEAT]);

  if (lastHb && now - lastHb > HEARTBEAT_STALE_LOG_MS) {
    console.debug('[Blocker] Heartbeat gap of', Math.round((now - lastHb) / 1000), 's (streak unaffected)');
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_HEARTBEAT]: now });
}

// Chrome wakes this worker for several reasons. Two of them mean the user did
// not switch the extension off: the browser just launched (onStartup), or the
// extension was installed/updated/reloaded (onInstalled). Chrome fires
// *nothing* on disable -> enable, which is the case we key the tamper check on.
let trustedStart = false;

async function breakStreak(reason) {
  const now = Date.now();
  await chrome.storage.local.set({
    [STORAGE_KEYS.START_DATE]: now,
    [STORAGE_KEYS.LAST_HEARTBEAT]: now,
    [STORAGE_KEYS.NEEDS_ALERT]: true
  });
  console.log('[Blocker] Streak reset —', reason);
}

async function verifyStreakIntegrity() {
  try {
    const now = Date.now();

    // Presence of the session marker means this worker is a revival within the
    // same extension lifetime. Absent means it was wiped — by a restart (which
    // trustedStart covers) or by the extension being switched off (which it
    // does not).
    const { [SW_ALIVE_KEY]: seenAlive } = await chrome.storage.session.get([SW_ALIVE_KEY]);
    await chrome.storage.session.set({ [SW_ALIVE_KEY]: now });

    const { [STORAGE_KEYS.START_DATE]: startDate } = await chrome.storage.local.get([STORAGE_KEYS.START_DATE]);
    if (!startDate) {
      // Very first run — start the clock; there is nothing to break yet.
      await chrome.storage.local.set({ [STORAGE_KEYS.START_DATE]: now, [STORAGE_KEYS.LAST_HEARTBEAT]: now });
      return;
    }

    if (seenAlive || trustedStart) return;

    await breakStreak('extension was switched off while the browser stayed running');
  } catch (err) {
    // Never break a real streak because of an internal error.
    console.warn('[Blocker] Streak check skipped:', err);
  }
}

// ============================================================
// 6. TAB EVENT LISTENERS — immediate time flush on tab switch
// ============================================================
chrome.tabs.onActivated.addListener(() => {
  trackActiveTab();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only react when the active tab's URL completes loading
  if (changeInfo.status === 'complete' && tab.active) {
    trackActiveTab();
  }
});

// ============================================================
// 7. ALARM HANDLERS
// ============================================================
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') {
    heartbeat();
  } else if (alarm.name === 'tracking') {
    trackActiveTab();
  } else if (alarm.name === 'dailyReset') {
    resetDailyLimits();
  }
});

// ============================================================
// 8. MESSAGE HANDLER — communication with settings page & popup
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.action) {
      case 'getRules': {
        const { [STORAGE_KEYS.BLOCKED_ITEMS]: items } = await chrome.storage.sync.get([STORAGE_KEYS.BLOCKED_ITEMS]);
        sendResponse({ success: true, rules: items || [] });
        break;
      }
      case 'getDailyUsage': {
        const { [STORAGE_KEYS.DAILY_USAGE]: usage } = await chrome.storage.local.get([STORAGE_KEYS.DAILY_USAGE]);
        sendResponse({ success: true, dailyUsage: usage || {} });
        break;
      }
      case 'saveRules': {
        await chrome.storage.sync.set({ [STORAGE_KEYS.BLOCKED_ITEMS]: message.rules });
        await syncAllRules();
        // Check if current active tab should be blocked after rule change
        await trackActiveTab();
        sendResponse({ success: true });
        break;
      }
      case 'syncRules': {
        await syncAllRules();
        sendResponse({ success: true });
        break;
      }
      case 'resetDaily': {
        await resetDailyLimits();
        sendResponse({ success: true });
        break;
      }
      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  })();
  return true; // Keep channel open for async response
});

// ============================================================
// 9. STARTUP — initialize everything
// ============================================================
let initialized = false;

async function initialize() {
  // The worker starts for whatever woke it, and a startup event may land on
  // top of that — re-running this would re-create the alarms and restart
  // their schedules, so do it once per worker lifetime.
  if (initialized) return;
  initialized = true;

  console.log('[Blocker] Initializing v2.0...');

  // Migrate old data format
  migrateData();

  // Stamp liveness
  await heartbeat();

  // Sync all DNR rules
  await syncAllRules();

  // Start per-minute time tracking
  chrome.alarms.create('tracking', { periodInMinutes: TRACKING_INTERVAL_SEC / 60 });

  // Schedule daily reset
  chrome.alarms.create('dailyReset', {
    when: Date.now() + getMsUntilMidnight(),
    periodInMinutes: 24 * 60
  });

  // Track immediately
  await trackActiveTab();

  console.log('[Blocker] Initialization complete.');
}

chrome.runtime.onStartup.addListener(() => {
  trustedStart = true;
  initialize();
});

chrome.runtime.onInstalled.addListener(() => {
  trustedStart = true;
  initialize();
});

// The worker also starts on its own (alarm, message, browser launch), so always
// initialize. The streak check waits a beat for the startup events above to
// land — otherwise a browser restart would look like tampering.
initialize()
  .catch(err => console.error('[Blocker] Initialization error:', err))
  .finally(() => setTimeout(verifyStreakIntegrity, START_EVENT_GRACE_MS));
