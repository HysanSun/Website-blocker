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
  NEEDS_ALERT: 'needsAlert',
  HAD_HOST_ACCESS: 'hadHostAccess',
  POMODORO: 'pomodoro',
  POMODORO_SETTINGS: 'pomodoroSettings',
  TODO: 'todo'
};
// Liveness marker in storage.session: it rides out service-worker suspension
// and system sleep, but is wiped when the extension is disabled/reloaded or
// the browser restarts.
const SW_ALIVE_KEY = 'swAlive';

// --- Pomodoro / todo constants ---
const POMODORO_ALARM = 'pomodoroPhase';
// Pomodoro rules get their own id band, and it has to stay BELOW
// TIMED_RULE_ID_OFFSET: the rest of the worker reads 'id >= that offset' as
// 'this is a timed rule' (enforceTimeLimit, resetDailyLimits), so a pomodoro
// rule caught by that filter would be silently dropped mid-session.
const POMODORO_RULE_ID_OFFSET = 1500000;
// A phase that expired longer ago than this is a stale transition (the machine
// was asleep or shut down). Used ONLY to decide whether a system notification
// is still worth showing - it must never affect crediting.
const POMODORO_NOTIFY_MAX_LATE_MS = 2 * 60 * 1000;
const POMODORO_NOTIFY_ID = 'pomodoro-phase';
const TASK_TEXT_MAX = 200;

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

// Every change to the dynamic rule set goes through this one queue.
// syncAllRules is called from alarm handlers, tab events and message handlers
// that Chrome does not serialize against each other. Two overlapping runs both
// read the current rules before either has added anything, so the second add
// dies with "Rule with id 1 does not have a unique ID" - and because the run
// that lands last wins, a stale rule set could survive instead (timed sites
// staying blocked after the focus session that pinned them had ended).
let dnrWriteQueue = Promise.resolve();
function withDnrLock(run) {
  const queued = dnrWriteQueue.then(run, run);
  // Keep the chain alive when a run rejects; the caller still sees the error.
  dnrWriteQueue = queued.then(() => {}, () => {});
  return queued;
}

function syncAllRules() {
  return withDnrLock(syncAllRulesNow);
}

// Replace the whole dynamic rule set in a single updateDynamicRules call: the
// removal and the addition are then one browser-process operation, so there is
// no window in which another writer could slip a conflicting id in between.
// A worker that is being torn down during an extension reload can still land a
// late call, so on the unique-id error read the stale set again and retry once.
async function applyDynamicRules(rulesToAdd) {
  // Belt and braces: an id appearing twice in one update is an immediate
  // failure in Chrome, so make that impossible no matter what the caller built.
  const seen = new Set();
  const unique = [];
  for (const rule of rulesToAdd) {
    if (seen.has(rule.id)) {
      console.warn('[Blocker] Dropped a duplicate DNR rule id', rule.id);
      continue;
    }
    seen.add(rule.id);
    unique.push(rule);
  }

  for (let attempt = 1; ; attempt++) {
    const stale = await chrome.declarativeNetRequest.getDynamicRules();
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: stale.map((r) => r.id),
        addRules: unique
      });
      return;
    } catch (err) {
      const retryable = /unique ID/i.test(String((err && err.message) || ''));
      if (!retryable || attempt >= 2) throw err;
    }
  }
}

async function syncAllRulesNow() {
  // Diagnostics for the catch below: what we asked for vs what was on disk.
  let wantedIds = [];
  let liveIds = [];
  try {
    // Get current state: blocked items + daily usage + pomodoro (for strictNow)
    const [syncData, localData] = await Promise.all([
      chrome.storage.sync.get([STORAGE_KEYS.BLOCKED_ITEMS]),
      chrome.storage.local.get([STORAGE_KEYS.DAILY_USAGE, STORAGE_KEYS.POMODORO])
    ]);

    const items = syncData[STORAGE_KEYS.BLOCKED_ITEMS] || [];
    const today = getTodayKey();
    const dailyUsage = localData[STORAGE_KEYS.DAILY_USAGE] || {};
    // A running focus session blocks timed sites outright, whatever today's
    // usage happens to be. The pomodoro state machine owns the decision and
    // mirrors it as strictNow, so there is exactly one place that decides.
    const strictNow = !!(localData[STORAGE_KEYS.POMODORO] && localData[STORAGE_KEYS.POMODORO].strictNow);

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
        // Time-limited: the rule goes in once the daily limit is exceeded, or
        // straight away while a focus session is holding the user to it.
        const usedToday = (dailyUsage[today] && dailyUsage[today][item.val])
          ? dailyUsage[today][item.val]
          : 0;
        const limitMs = (item.limitMin || 30) * 60 * 1000;

        if (strictNow || usedToday >= limitMs) {
          const filterPattern = `*://*.${item.val}/*`;
          rulesToAdd.push({
            // Separate band per reason: it keeps these rules out of the
            // enforceTimeLimit / resetDailyLimits filter, which owns quota rules.
            id: strictNow ? POMODORO_RULE_ID_OFFSET + idx : TIMED_RULE_ID_OFFSET + idx,
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

    // Clears the previous set and installs the new one in one atomic update,
    // including when rulesToAdd is empty.
    wantedIds = rulesToAdd.map((r) => r.id);
    try {
      liveIds = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
    } catch (e) { /* diagnostics only */ }
    await applyDynamicRules(rulesToAdd);
    console.log('[Blocker] Synced', rulesToAdd.length, 'DNR rules');
  } catch (err) {
    console.error('[Blocker] syncAllRules error:', err,
      '| wanted rule ids', wantedIds.join(',') || '(none)',
      '| live rule ids', liveIds.join(',') || '(none)');
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

// Same lock: this writes to the same dynamic rule set as syncAllRules.
function enforceTimeLimit(domain, limitMin) {
  return withDnrLock(() => enforceTimeLimitNow(domain, limitMin));
}

async function enforceTimeLimitNow(domain, limitMin) {
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
// Same lock again: it removes rules syncAllRules would otherwise re-add.
function resetDailyLimits() {
  return withDnrLock(resetDailyLimitsNow);
}

async function resetDailyLimitsNow() {
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
// The streak (startDate) is broken by exactly three things:
//   a) the extension being switched off and back on,
//   b) the user revoking the extension's site access (<all_urls>), or
//   c) the user pressing "Reset Streak" in the popup.
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

  // A focus session cannot be trusted once the user has broken the setup the
  // extension enforces: the blocker stopped working, so the session is void.
  // This is a one-way call (streak -> pomodoro); the pomodoro never reads back.
  await pomodoroStop();
  await pomodoroAfterChange();
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

    // Host ("site access") permission. Chrome may hand a fresh install
    // <all_urls> as "when you click the extension", so a plain `false` here is
    // not evidence of tampering — it is the normal starting state. Only a
    // true -> false transition counts: access we had was taken away, and the
    // blocker silently stopped working.
    const hasHostAccess = await chrome.permissions.contains({ origins: ['<all_urls>'] });
    const { [STORAGE_KEYS.HAD_HOST_ACCESS]: hadHostAccess } = await chrome.storage.local.get([STORAGE_KEYS.HAD_HOST_ACCESS]);

    if (hasHostAccess !== !!hadHostAccess) {
      await chrome.storage.local.set({ [STORAGE_KEYS.HAD_HOST_ACCESS]: hasHostAccess });
    }

    if (!startDate) {
      // Very first run — start the clock; there is nothing to break yet.
      await chrome.storage.local.set({ [STORAGE_KEYS.START_DATE]: now, [STORAGE_KEYS.LAST_HEARTBEAT]: now });
      return;
    }

    if (!hasHostAccess && hadHostAccess) {
      await breakStreak('site access was revoked');
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
// 6. POMODORO & TODO
//
// Pomodoro and the streak are two isolated subsystems. Nothing in this
// section may read or write startDate / needsAlert / hadHostAccess / swAlive:
// an in-memory countdown here would be exactly the bug the streak fix
// removed, and a wall-clock gap in this section is plain timer semantics,
// never tamper detection. Keep them apart.
//
// The stored deadline endAt is the only authority. Every render is a pure
// (endAt - now) evaluation, so service-worker recycling, system sleep and
// browser restarts cannot corrupt the countdown.
// ============================================================

const POMODORO_SETTINGS_DEFAULTS = {
  v: 1,
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  cyclesUntilLongBreak: 4,
  autoStartBreak: true,
  autoStartFocus: false,
  focusBlocksTimed: true
};

const POMODORO_STATE_DEFAULTS = {
  v: 1,
  phase: 'idle',
  endAt: 0,
  startedAt: 0,
  pausedRemainingMs: null,
  cycleDone: 0,
  dayKey: '',
  focusToday: 0,
  focusMsToday: 0,
  taskId: null,
  strictNow: false
};

// Overlapping async calls (a per-second popup tick landing on top of the
// tracking alarm) must never credit the same session twice.
let pomodoroBusy = false;
let taskIdSeq = 0;

function sanitizePomodoroSettings(raw) {
  const s = Object.assign({}, POMODORO_SETTINGS_DEFAULTS, raw || {});
  const clamp = (value, lo, hi, fallback) => {
    const n = Number(value);
    if (!isFinite(n) || n <= 0) return fallback;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  s.focusMin = clamp(s.focusMin, 1, 180, 25);
  s.shortBreakMin = clamp(s.shortBreakMin, 1, 60, 5);
  s.longBreakMin = clamp(s.longBreakMin, 1, 120, 15);
  s.cyclesUntilLongBreak = clamp(s.cyclesUntilLongBreak, 1, 12, 4);
  s.autoStartBreak = !!s.autoStartBreak;
  s.autoStartFocus = !!s.autoStartFocus;
  s.focusBlocksTimed = !!s.focusBlocksTimed;
  s.v = 1;
  return s;
}

async function getPomodoroSettings() {
  const res = await chrome.storage.sync.get([STORAGE_KEYS.POMODORO_SETTINGS]);
  return sanitizePomodoroSettings(res[STORAGE_KEYS.POMODORO_SETTINGS]);
}

async function getPomodoroState() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.POMODORO]);
  const state = Object.assign({}, POMODORO_STATE_DEFAULTS, res[STORAGE_KEYS.POMODORO] || {});
  // Day rollover clears the daily counters but keeps the cycle position, so a
  // long break that is still due stays due.
  const today = getTodayKey();
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.focusToday = 0;
    state.focusMsToday = 0;
  }
  return state;
}

async function writePomodoroState(state, settings) {
  const s = settings || await getPomodoroSettings();
  // Pausing does NOT lift the strictness: the promise of this tool is that you
  // cannot negotiate with it. Only an explicit stop or skip leaves focus mode.
  state.strictNow = (state.phase === 'focus' && !!s.focusBlocksTimed);
  state.v = 1;
  state.dayKey = getTodayKey();
  await chrome.storage.local.set({ [STORAGE_KEYS.POMODORO]: state });
  return state;
}

function pomodoroRemainingMs(state) {
  if (state.phase === 'idle') return 0;
  const paused = state.pausedRemainingMs;
  if (paused !== null && paused !== undefined) return Math.max(0, paused);
  return Math.max(0, state.endAt - Date.now());
}

function pomodoroPhaseMs(phase, settings) {
  if (phase === 'focus') return settings.focusMin * 60 * 1000;
  if (phase === 'shortBreak') return settings.shortBreakMin * 60 * 1000;
  if (phase === 'longBreak') return settings.longBreakMin * 60 * 1000;
  return 0;
}

async function armPomodoroAlarm() {
  const state = await getPomodoroState();
  await chrome.alarms.clear(POMODORO_ALARM);
  const paused = state.pausedRemainingMs !== null && state.pausedRemainingMs !== undefined;
  if (state.phase !== 'idle' && !paused && state.endAt > 0) {
    chrome.alarms.create(POMODORO_ALARM, { when: state.endAt });
  }
}

async function updatePomodoroBadge() {
  try {
    const state = await getPomodoroState();
    if (state.phase === 'idle') {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const mins = Math.max(1, Math.ceil(pomodoroRemainingMs(state) / 60000));
    await chrome.action.setBadgeText({ text: String(mins) });
    await chrome.action.setBadgeBackgroundColor({
      color: state.phase === 'focus' ? '#e67e22' : '#27ae60'
    });
  } catch (err) {
    // The badge is decoration; never let it break a transition.
    console.debug('[Blocker] Pomodoro badge skipped:', err.message);
  }
}

// chrome.notifications only exists once the permission has actually been
// granted, and reloading an unpacked extension after a permission was added
// does NOT grant it. Notifications are optional everywhere.
function notificationsAvailable() {
  return !!(chrome.notifications && chrome.notifications.create);
}

function notifyPomodoroPhase(fromPhase, toPhase, lateMs, settings) {
  // A phase that expired hours ago (machine asleep or shut down) is old news.
  // This guard is about the notification only - the session is still credited.
  if (lateMs > POMODORO_NOTIFY_MAX_LATE_MS) return;
  if (!notificationsAvailable()) return;
  const title = (fromPhase === 'focus') ? 'Focus complete' : 'Break over';
  let message = 'Ready when you are.';
  if (toPhase === 'shortBreak') message = 'Take a ' + settings.shortBreakMin + ' min break.';
  else if (toPhase === 'longBreak') message = 'Take a ' + settings.longBreakMin + ' min long break.';
  else if (toPhase === 'focus') message = 'Next focus session: ' + settings.focusMin + ' min.';
  else if (fromPhase === 'focus') message = 'Session recorded.';
  try {
    chrome.notifications.create(POMODORO_NOTIFY_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon.png'),
      title: title,
      message: message
    });
  } catch (err) {
    console.debug('[Blocker] Pomodoro notification skipped:', err.message);
  }
}

// Exactly one transition per call, and credit is false for skip (the session
// is not counted). The next phase always starts from `now`, never from the
// stale deadline: a session that expired three hours ago advances exactly one
// phase and credits exactly one, never a chain of them.
async function pomodoroEnterNextPhase(state, settings, now, credit) {
  const from = state.phase;
  let next = 'idle';

  if (from === 'focus') {
    if (credit) {
      state.cycleDone += 1;
      state.focusToday += 1;
      state.focusMsToday += settings.focusMin * 60 * 1000;
      await creditTaskFocus(state.taskId, settings.focusMin);
    }
    const cycles = Math.max(1, settings.cyclesUntilLongBreak);
    // A skipped focus has nothing to show for it, so it must never earn the
    // long break: cycleDone stays put, and 0 % cycles === 0 would otherwise
    // hand out a long break on the very first skip.
    const longBreakDue = credit && state.cycleDone > 0 && (state.cycleDone % cycles === 0);
    next = longBreakDue ? 'longBreak' : 'shortBreak';
    if (!settings.autoStartBreak) next = 'idle';
  } else if (from === 'shortBreak') {
    next = settings.autoStartFocus ? 'focus' : 'idle';
  } else if (from === 'longBreak') {
    // A long break closes the cycle, whether it ran out or was skipped.
    state.cycleDone = 0;
    next = settings.autoStartFocus ? 'focus' : 'idle';
  }

  state.pausedRemainingMs = null;

  if (next === 'idle') {
    state.phase = 'idle';
    state.endAt = 0;
    state.startedAt = 0;
    return;
  }

  state.phase = next;
  state.startedAt = now;
  state.endAt = now + pomodoroPhaseMs(next, settings);
}

async function pomodoroTick() {
  if (pomodoroBusy) return { changed: false };
  pomodoroBusy = true;
  try {
    const state = await getPomodoroState();
    const now = Date.now();
    const paused = state.pausedRemainingMs !== null && state.pausedRemainingMs !== undefined;
    if (state.phase === 'idle' || paused) return { changed: false };
    if (!state.endAt || now < state.endAt) return { changed: false };

    const settings = await getPomodoroSettings();
    const lateMs = now - state.endAt;
    const fromPhase = state.phase;
    await pomodoroEnterNextPhase(state, settings, now, true);
    await writePomodoroState(state, settings);
    notifyPomodoroPhase(fromPhase, state.phase, lateMs, settings);
    return { changed: true };
  } catch (err) {
    console.warn('[Blocker] Pomodoro tick skipped:', err);
    return { changed: false };
  } finally {
    pomodoroBusy = false;
  }
}

async function pomodoroAfterChange() {
  await syncAllRules();
  await armPomodoroAlarm();
  await updatePomodoroBadge();
}

async function pomodoroTickAndApply() {
  const result = await pomodoroTick();
  if (result.changed) await pomodoroAfterChange();
  return result;
}

// Alarm callbacks are fire-and-forget, so they need the rejection swallowed.
function pomodoroTickAndApplySafe() {
  return pomodoroTickAndApply()
    .catch(err => console.warn('[Blocker] Pomodoro alarm skipped:', err));
}

async function pomodoroStatus() {
  const [state, settings] = await Promise.all([getPomodoroState(), getPomodoroSettings()]);
  return {
    state: state,
    settings: settings,
    remainingMs: pomodoroRemainingMs(state),
    notifications: notificationsAvailable()
  };
}

async function pomodoroStart(taskId) {
  const [settings, state] = await Promise.all([getPomodoroSettings(), getPomodoroState()]);
  const now = Date.now();
  state.phase = 'focus';
  state.startedAt = now;
  state.endAt = now + settings.focusMin * 60 * 1000;
  state.pausedRemainingMs = null;
  // No taskId in the message means keep the current selection; an explicit
  // null means clear it.
  if (taskId !== undefined) state.taskId = taskId || null;
  return writePomodoroState(state, settings);
}

async function pomodoroPause() {
  const state = await getPomodoroState();
  const paused = state.pausedRemainingMs !== null && state.pausedRemainingMs !== undefined;
  if (state.phase === 'idle' || paused) return writePomodoroState(state);
  state.pausedRemainingMs = Math.max(0, state.endAt - Date.now());
  state.endAt = 0;
  return writePomodoroState(state);
}

async function pomodoroResume() {
  const state = await getPomodoroState();
  const paused = state.pausedRemainingMs !== null && state.pausedRemainingMs !== undefined;
  if (state.phase === 'idle' || !paused) return writePomodoroState(state);
  state.endAt = Date.now() + state.pausedRemainingMs;
  state.pausedRemainingMs = null;
  return writePomodoroState(state);
}

// Skip moves on without recording anything. Stop drops back to idle and keeps
// the cycle position: both are user decisions, not tamper signals.
async function pomodoroSkip() {
  const state = await getPomodoroState();
  if (state.phase === 'idle') return writePomodoroState(state);
  const settings = await getPomodoroSettings();
  state.pausedRemainingMs = null;
  await pomodoroEnterNextPhase(state, settings, Date.now(), false);
  return writePomodoroState(state, settings);
}

async function pomodoroStop() {
  const state = await getPomodoroState();
  state.phase = 'idle';
  state.endAt = 0;
  state.startedAt = 0;
  state.pausedRemainingMs = null;
  return writePomodoroState(state);
}

// --- todo list ---

function normalizeTodo(raw) {
  const todo = (raw && typeof raw === 'object') ? raw : {};
  if (!Array.isArray(todo.tasks)) todo.tasks = [];
  todo.v = 1;
  return todo;
}

async function getTodo() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.TODO]);
  return normalizeTodo(res[STORAGE_KEYS.TODO]);
}

async function saveTodo(todo) {
  todo.v = 1;
  await chrome.storage.local.set({ [STORAGE_KEYS.TODO]: todo });
  return todo;
}

function newTaskId() {
  taskIdSeq = (taskIdSeq + 1) % 46656;
  return Date.now().toString(36) + '-' + taskIdSeq.toString(36) + '-' +
    Math.random().toString(36).slice(2, 6);
}

function sanitizeTaskText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, TASK_TEXT_MAX);
}

function findTask(todo, id) {
  for (let i = 0; i < todo.tasks.length; i++) {
    if (todo.tasks[i] && todo.tasks[i].id === id) return todo.tasks[i];
  }
  return null;
}

// Crediting a task that was deleted mid-session is not an error - it simply
// has nowhere to go, and the session itself is still recorded.
async function creditTaskFocus(taskId, focusMin) {
  if (!taskId) return;
  const todo = await getTodo();
  const task = findTask(todo, taskId);
  if (!task) return;
  task.pomodoros = (task.pomodoros || 0) + 1;
  task.focusMs = (task.focusMs || 0) + focusMin * 60 * 1000;
  await saveTodo(todo);
}

async function todoAdd(text) {
  const clean = sanitizeTaskText(text);
  if (!clean) return { ok: false, todo: await getTodo() };
  const todo = await getTodo();
  todo.tasks.push({
    id: newTaskId(),
    text: clean,
    done: false,
    createdAt: Date.now(),
    doneAt: 0,
    pomodoros: 0,
    focusMs: 0
  });
  return { ok: true, todo: await saveTodo(todo) };
}

async function todoUpdate(id, text) {
  const clean = sanitizeTaskText(text);
  const todo = await getTodo();
  const task = findTask(todo, id);
  if (task && clean) task.text = clean;
  return saveTodo(todo);
}

async function todoToggle(id) {
  const todo = await getTodo();
  const task = findTask(todo, id);
  if (task) {
    task.done = !task.done;
    task.doneAt = task.done ? Date.now() : 0;
  }
  return saveTodo(todo);
}

async function todoRemove(id) {
  const todo = await getTodo();
  todo.tasks = todo.tasks.filter(t => t && t.id !== id);
  return saveTodo(todo);
}

async function todoMove(id, direction) {
  const todo = await getTodo();
  const idx = todo.tasks.findIndex(t => t && t.id === id);
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (idx >= 0 && target >= 0 && target < todo.tasks.length) {
    const moved = todo.tasks.splice(idx, 1)[0];
    todo.tasks.splice(target, 0, moved);
  }
  return saveTodo(todo);
}

async function todoClearDone() {
  const todo = await getTodo();
  todo.tasks = todo.tasks.filter(t => t && !t.done);
  return saveTodo(todo);
}

// Registered defensively and kept last in the section: this used to be an
// unconditional top-level call, and when the notifications permission had not
// been granted the TypeError aborted the rest of this file - no message
// handler, no alarm handler, no initialize(), no blocking at all.
if (notificationsAvailable() && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    if (id === POMODORO_NOTIFY_ID) chrome.notifications.clear(id);
  });
}

// ============================================================
// 7. TAB EVENT LISTENERS — immediate time flush on tab switch
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
// 8. ALARM HANDLERS
// ============================================================
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') {
    heartbeat();
  } else if (alarm.name === 'tracking') {
    trackActiveTab();
    pomodoroTickAndApplySafe();
  } else if (alarm.name === POMODORO_ALARM) {
    pomodoroTickAndApplySafe();
  } else if (alarm.name === 'dailyReset') {
    resetDailyLimits();
  }
});

// ============================================================
// 9. MESSAGE HANDLER — communication with settings page & popup
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
      case 'pomodoroGetState': {
        sendResponse(Object.assign({ success: true }, await pomodoroStatus()));
        break;
      }
      case 'pomodoroStart': {
        await pomodoroStart(message.taskId);
        await pomodoroAfterChange();
        sendResponse(Object.assign({ success: true }, await pomodoroStatus()));
        break;
      }
      case 'pomodoroPause': {
        await pomodoroPause();
        await pomodoroAfterChange();
        sendResponse(Object.assign({ success: true }, await pomodoroStatus()));
        break;
      }
      case 'pomodoroResume': {
        await pomodoroResume();
        await pomodoroAfterChange();
        sendResponse(Object.assign({ success: true }, await pomodoroStatus()));
        break;
      }
      case 'pomodoroSkip': {
        await pomodoroSkip();
        await pomodoroAfterChange();
        sendResponse(Object.assign({ success: true }, await pomodoroStatus()));
        break;
      }
      case 'pomodoroStop': {
        await pomodoroStop();
        await pomodoroAfterChange();
        sendResponse(Object.assign({ success: true }, await pomodoroStatus()));
        break;
      }
      case 'pomodoroTick': {
        await pomodoroTickAndApply();
        sendResponse(Object.assign({ success: true }, await pomodoroStatus()));
        break;
      }
      case 'pomodoroSaveSettings': {
        const clean = sanitizePomodoroSettings(message.settings);
        await chrome.storage.sync.set({ [STORAGE_KEYS.POMODORO_SETTINGS]: clean });
        // Refresh strictNow against the new settings before re-deriving rules.
        await writePomodoroState(await getPomodoroState(), clean);
        await pomodoroAfterChange();
        sendResponse(Object.assign({ success: true }, await pomodoroStatus()));
        break;
      }
      case 'todoGet': {
        sendResponse({ success: true, tasks: (await getTodo()).tasks });
        break;
      }
      case 'todoAdd': {
        const added = await todoAdd(message.text);
        sendResponse({ success: added.ok, tasks: added.todo.tasks, error: added.ok ? null : 'empty' });
        break;
      }
      case 'todoUpdate': {
        sendResponse({ success: true, tasks: (await todoUpdate(message.id, message.text)).tasks });
        break;
      }
      case 'todoToggle': {
        sendResponse({ success: true, tasks: (await todoToggle(message.id)).tasks });
        break;
      }
      case 'todoRemove': {
        sendResponse({ success: true, tasks: (await todoRemove(message.id)).tasks });
        break;
      }
      case 'todoMove': {
        sendResponse({ success: true, tasks: (await todoMove(message.id, message.direction)).tasks });
        break;
      }
      case 'todoClearDone': {
        sendResponse({ success: true, tasks: (await todoClearDone()).tasks });
        break;
      }
      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
  })();
  return true; // Keep channel open for async response
});

// ============================================================
// 10. STARTUP — initialize everything
// ============================================================
let initialized = false;

async function initialize() {
  // The worker starts for whatever woke it, and a startup event may land on
  // top of that — re-running this would re-create the alarms and restart
  // their schedules, so do it once per worker lifetime.
  if (initialized) return;
  initialized = true;

  const manifestVersion = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || 'unknown';
  console.log('[Blocker] Initializing v' + manifestVersion + '...');

  // Migrate old data format
  migrateData();

  // Stamp liveness
  await heartbeat();

  // Reconcile the pomodoro from its stored deadline before the rules are
  // derived, so an expired session is credited and strictNow is current.
  await pomodoroTick();

  // Sync all DNR rules
  await syncAllRules();

  await armPomodoroAlarm();
  await updatePomodoroBadge();

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
