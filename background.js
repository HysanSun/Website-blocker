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
  USAGE_CLOCK: 'usageClock',
  TEMP_UNLOCKS: 'tempUnlocks',
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
// Exception rules get their own band, below both of the others, so nothing that
// filters on "id >= TIMED_RULE_ID_OFFSET" can sweep them up. The full ladder:
// 1..N complete blocks, 1000000+ exceptions, 1500000+ timed rules pinned by a
// focus session, 2000000+ timed rules that are over quota.
const ALLOW_RULE_ID_OFFSET = 1000000;
// Temporary unlocks ("let me through for 30 minutes") get a band above
// everything else so nothing that filters on a lower offset can sweep them up.
const TEMP_UNLOCK_ID_OFFSET = 3000000;
const TEMP_UNLOCK_ALARM = 'tempUnlock';
const TEMP_UNLOCK_MAX_MIN = 240;
const TEMP_UNLOCK_DEFAULT_MIN = 30;
// The resource types every website rule covers, so the three places that build
// a rule cannot drift apart.
const RULE_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script',
  'image', 'xmlhttprequest', 'other'];
// A phase that expired longer ago than this is a stale transition (the machine
// was asleep or shut down). Used ONLY to decide whether a system notification
// is still worth showing - it must never affect crediting.
const POMODORO_NOTIFY_MAX_LATE_MS = 2 * 60 * 1000;
const POMODORO_NOTIFY_ID = 'pomodoro-phase';
const QUOTA_WARNING_NOTIFY_ID = 'quota-warning';
// A focus session may be paused exactly once, and for no longer than this: the
// clock turns itself back on. Breaks are not limited - nothing is being
// enforced while you are resting.
const POMODORO_MAX_PAUSE_MS = 2 * 60 * 1000;
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
//
// A rule whose value starts with '!' is an exception: "never block this host",
// covering the host itself and everything under it. Blocking a domain is
// deliberately wider than the domain (its urlFilter is `||host^`), which is
// what makes "block baidu.com" also close pan.baidu.com - so an exception is how
// you keep using one service without opening the whole site back up.
//
// Exceptions live in the same list the settings page already renders and can
// delete, so they need no new UI: type `!pan.baidu.com` where you would type a
// site to block.
function isException(item) {
  return !!(item && typeof item.val === 'string' && item.val.trim().charAt(0) === '!');
}

// 'https://*.pan.baidu.com/x' -> 'pan.baidu.com'
function normalizeHost(value) {
  return String(value == null ? '' : value).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '')
    .replace(/^\./, '');
}

// '!pan.baidu.com' -> 'pan.baidu.com'. Anything that is not marked as an
// exception has no excepted host at all.
function exceptionHost(item) {
  const raw = String((item && item.val) || '').trim();
  return raw.charAt(0) === '!' ? normalizeHost(raw.slice(1)) : '';
}

// A value covers its host and every subdomain of it, and nothing else: 'x.com'
// matches x.com and a.x.com, never notx.com. Same scope as the DNR urlFilter
// `||x.com^`, so the two layers agree. Keep this identical to the copy in
// content.js.
function hostMatches(host, value) {
  const h = String(host || '').toLowerCase();
  const d = normalizeHost(value);
  return !!d && (h === d || h.endsWith('.' + d));
}

// The urlFilter for "this host and every subdomain of it, and nothing else".
// `||host^` matches the apex as well; the older `*://*.host/*` form did not - a
// rule for `baidu.com` never blocked `baidu.com` itself, only its subdomains -
// and it stops at a host boundary, so `baidu.com.evil.com` stays reachable where
// `*://*.baidu.com/*` would have caught it too. Verified against Chromium with
// declarativeNetRequestFeedback / testMatchOutcome; do not fold it back.
function hostUrlFilter(value) {
  const host = normalizeHost(value);
  return host ? `||${host}^` : '';
}

function hostOfUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

function isExceptedHost(items, host) {
  for (const item of items || []) {
    if (isException(item) && hostMatches(host, exceptionHost(item))) return true;
  }
  return false;
}

// --- rule time windows ----------------------------------------------------
// A rule may carry `window: { days: [0..6], from: 'HH:MM', to: 'HH:MM' }`,
// where 0 is Sunday. Outside its window a rule is not enforced and a timed rule
// is not counted - the site simply is not on the list for that hour. `to`
// earlier than `from` means the window runs past midnight, and the part after
// midnight still belongs to the day it started on.
function parseClock(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text).trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function hasWindow(item) {
  return !!(item && item.window && typeof item.window === 'object');
}

function ruleWindowActive(item, date) {
  if (!hasWindow(item)) return true;
  const from = parseClock(item.window.from);
  const to = parseClock(item.window.to);
  // A window nobody can read would silently switch the rule off, and staying
  // blocked is the safe direction to fail in.
  if (from === null || to === null) return true;
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const crossesMidnight = from > to;
  const inRange = crossesMidnight
    ? (nowMin >= from || nowMin < to)
    : (nowMin >= from && nowMin < to);
  const days = Array.isArray(item.window.days) ? item.window.days : null;
  if (!days || !days.length) return inRange;
  const day = date.getDay();
  const belongsTo = (crossesMidnight && nowMin < to) ? (day + 6) % 7 : day;
  return inRange && days.indexOf(belongsTo) !== -1;
}

// One character per windowed rule: enough to notice that a window opened or
// closed without recomputing the whole rule set every minute.
function windowSignatureOf(items, date) {
  const now = date || new Date();
  return (items || []).filter(hasWindow)
    .map(item => (ruleWindowActive(item, now) ? '1' : '0'))
    .join('');
}

let lastWindowSignature = null;

// --- temporary unlocks ----------------------------------------------------
// The escape hatch that does not require deleting the extension. Keyed by host,
// so it can only ever open the site the user was looking at, and it expires on
// its own.
function tempUnlockHosts(raw, now) {
  const map = (raw && typeof raw === 'object') ? raw : {};
  const out = [];
  for (const key of Object.keys(map)) {
    const until = Number(map[key]);
    if (isFinite(until) && until > now) out.push({ host: normalizeHost(key), until: until });
  }
  return out;
}

async function getTempUnlocks() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.TEMP_UNLOCKS]);
  return tempUnlockHosts(res[STORAGE_KEYS.TEMP_UNLOCKS], Date.now());
}

async function tempUnlock(val, minutes) {
  const host = normalizeHost(val);
  if (!host) return null;
  const res = await chrome.storage.local.get([STORAGE_KEYS.TEMP_UNLOCKS]);
  const map = (res[STORAGE_KEYS.TEMP_UNLOCKS] && typeof res[STORAGE_KEYS.TEMP_UNLOCKS] === 'object')
    ? res[STORAGE_KEYS.TEMP_UNLOCKS] : {};
  // minutes === 0 is "lock it again now", so the caller does not need a second
  // message just to undo this one.
  if (Number(minutes) === 0) {
    delete map[host];
    await chrome.storage.local.set({ [STORAGE_KEYS.TEMP_UNLOCKS]: map });
    return { host: host, until: 0 };
  }
  const mins = Math.min(TEMP_UNLOCK_MAX_MIN,
    Math.max(1, Math.round(Number(minutes) || TEMP_UNLOCK_DEFAULT_MIN)));
  map[host] = Date.now() + mins * 60 * 1000;
  await chrome.storage.local.set({ [STORAGE_KEYS.TEMP_UNLOCKS]: map });
  return { host: host, until: map[host] };
}

async function expireTempUnlocks() {
  const res = await chrome.storage.local.get([STORAGE_KEYS.TEMP_UNLOCKS]);
  const map = res[STORAGE_KEYS.TEMP_UNLOCKS];
  if (!map || typeof map !== 'object') return false;
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!(Number(map[key]) > now)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [STORAGE_KEYS.TEMP_UNLOCKS]: map });
  return changed;
}

async function armTempUnlockAlarm() {
  await chrome.alarms.clear(TEMP_UNLOCK_ALARM);
  const unlocks = await getTempUnlocks();
  if (!unlocks.length) return;
  const soonest = Math.min.apply(null, unlocks.map(u => u.until));
  chrome.alarms.create(TEMP_UNLOCK_ALARM, { when: soonest });
}

// The block page is told which rule sent the tab there, so it can offer the one
// thing the user actually wants at that moment: a timed way back in. Carrying it
// in the redirect path is the only signal available - by the time the tab is on
// blockpage.html, the original URL is gone. A keyword rule has no host, so it
// gets the bare page.
function blockRedirectPath(item) {
  if (item && item.mode === 'website' && item.val) {
    return '/blockpage.html?host=' + encodeURIComponent(String(item.val));
  }
  return '/blockpage.html';
}

// Every write to the dynamic rule set goes through this one queue, so the
// helpers above it are pure and can be called from anywhere.
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

// Write the whole dynamic rule set in ONE updateDynamicRules call.
//
// Chrome rejects an add whose id is still live with "Rule with id N does not
// have a unique ID", and the live rule set can disagree with what
// getDynamicRules() reports - a worker torn down mid-write can leave an id that
// is still enforced but never listed. The removal therefore asks for the ids we
// are about to add *as well as* everything getDynamicRules() reports, and does
// it in the same call as the add.
//
// Doing both in one call matters twice over: Chrome applies remove+add
// together, so there is no window in which the sites are left unblocked and no
// gap another writer can slip an add into - the write either fully applies or
// leaves the previous set in place. Callers are serialized by withDnrLock();
// the retry covers a writer from outside this worker (a worker being torn down
// during a reload can land a late write).
async function applyDynamicRules(rulesToAdd) {
  // An id appearing twice in one call is an immediate failure in Chrome, so
  // make that impossible no matter what the caller handed us.
  const unique = [];
  const wantedIds = [];
  const seen = new Set();
  for (const rule of rulesToAdd) {
    if (seen.has(rule.id)) {
      console.warn('[Blocker] Dropped a duplicate DNR rule id', rule.id);
      continue;
    }
    seen.add(rule.id);
    wantedIds.push(rule.id);
    unique.push(rule);
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const stale = await chrome.declarativeNetRequest.getDynamicRules();
      const removeIds = [];
      const removeSeen = new Set();
      for (const id of stale.map((r) => r.id).concat(wantedIds)) {
        if (removeSeen.has(id)) continue;
        removeSeen.add(id);
        removeIds.push(id);
      }

      const update = {};
      if (removeIds.length) update.removeRuleIds = removeIds;
      if (unique.length) update.addRules = unique;
      if (!update.removeRuleIds && !update.addRules) return;
      await chrome.declarativeNetRequest.updateDynamicRules(update);
      return;
    } catch (err) {
      // Re-read the live set and try the whole thing again: the collision came
      // from a rule that appeared between our read and our write.
      const retryable = /unique ID/i.test(String((err && err.message) || ''));
      if (!retryable || attempt >= 3) throw err;
    }
  }
}

async function syncAllRulesNow() {
  // Declared outside the try on purpose: the catch block reports all three, and
  // a const declared inside the try is not in scope there. Getting this wrong
  // turned every rule-write failure into "ReferenceError: items is not defined"
  // thrown from the catch itself, which then escaped syncAllRules - the popup
  // never got its reply and startup stopped before the alarms were created.
  let wantedIds = [];
  let liveIds = [];
  let items = [];
  try {
    // Get current state: blocked items + daily usage + pomodoro (for strictNow)
    const [syncData, localData] = await Promise.all([
      chrome.storage.sync.get([STORAGE_KEYS.BLOCKED_ITEMS]),
      chrome.storage.local.get([STORAGE_KEYS.DAILY_USAGE, STORAGE_KEYS.POMODORO,
        STORAGE_KEYS.TEMP_UNLOCKS])
    ]);

    items = syncData[STORAGE_KEYS.BLOCKED_ITEMS] || [];
    const now = new Date();
    const today = getTodayKey();
    const dailyUsage = localData[STORAGE_KEYS.DAILY_USAGE] || {};
    // A running focus session blocks timed sites outright, whatever today's
    // usage happens to be. The pomodoro state machine owns the decision and
    // mirrors it as strictNow, so there is exactly one place that decides.
    const strictNow = !!(localData[STORAGE_KEYS.POMODORO] && localData[STORAGE_KEYS.POMODORO].strictNow);

    const rulesToAdd = [];
    let ruleIndex = 0;

    const uniqueExceptions = [];
    for (const item of items) {
      if (!isException(item)) continue;
      const host = exceptionHost(item);
      if (host && uniqueExceptions.indexOf(host) === -1) uniqueExceptions.push(host);
    }

    items.forEach((item, idx) => {
      if (isException(item)) return;   // exceptions become allow rules below
      // Outside its window a rule is simply not on today's list - not weaker,
      // absent - and a timed rule does not accrue quota either.
      if (!ruleWindowActive(item, now)) return;
      if (item.type === 'block') {
        // Complete block — always register DNR rule
        const filterPattern = (item.mode === 'website')
          ? hostUrlFilter(item.val)
          : `*://*/*?*q=*${item.val}*`;

        rulesToAdd.push({
          id: ruleIndex + 1,
          priority: 10,
          action: { type: 'redirect', redirect: { extensionPath: blockRedirectPath(item) } },
          condition: {
            urlFilter: filterPattern,
            resourceTypes: RULE_RESOURCE_TYPES
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
          const filterPattern = hostUrlFilter(item.val);
          rulesToAdd.push({
            // Separate band per reason: it keeps these rules out of the
            // enforceTimeLimit / resetDailyLimits filter, which owns quota rules.
            id: strictNow ? POMODORO_RULE_ID_OFFSET + idx : TIMED_RULE_ID_OFFSET + idx,
            priority: 10,
            action: { type: 'redirect', redirect: { extensionPath: blockRedirectPath(item) } },
            condition: {
              urlFilter: filterPattern,
              resourceTypes: RULE_RESOURCE_TYPES
            }
          });
        }
      }
    });

    // One allow rule per exception host, at a priority no redirect rule uses.
    // The highest-priority matching rule decides the request, and an allow beats
    // a redirect, so pan.baidu.com stays reachable while baidu.com stays closed.
    for (const host of uniqueExceptions) {
      rulesToAdd.push({
        id: ALLOW_RULE_ID_OFFSET + rulesToAdd.length,
        priority: 100,
        action: { type: 'allow' },
        condition: { urlFilter: hostUrlFilter(host), resourceTypes: RULE_RESOURCE_TYPES }
      });
    }

    // A temporary unlock is an allow rule just like an exception, but it
    // carries an expiry and lives in its own id band so the two can never
    // collide.
    for (const unlock of tempUnlockHosts(localData[STORAGE_KEYS.TEMP_UNLOCKS], now.getTime())) {
      rulesToAdd.push({
        id: TEMP_UNLOCK_ID_OFFSET + rulesToAdd.length,
        priority: 100,
        action: { type: 'allow' },
        condition: { urlFilter: hostUrlFilter(unlock.host), resourceTypes: RULE_RESOURCE_TYPES }
      });
    }

    // Remember which windows are open, so the per-minute tracker can notice a
    // window opening or closing without recomputing the rules every tick.
    lastWindowSignature = windowSignatureOf(items, now);

    // Clears the previous set and installs the new one in one atomic update,
    // including when rulesToAdd is empty.
    wantedIds = rulesToAdd.map((r) => r.id);
    try {
      liveIds = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
    } catch (e) { /* diagnostics only */ }
    await applyDynamicRules(rulesToAdd);
    console.log('[Blocker] Synced', rulesToAdd.length, 'DNR rules');
  } catch (err) {
    console.error('[Blocker] syncAllRules error: ' + ((err && err.message) || err) +
      ' | wanted rule ids [' + (wantedIds.join(',') || 'none') + ']' +
      ' | live rule ids [' + (liveIds.join(',') || 'none') + ']' +
      ' | rules [', JSON.stringify(items).slice(0, 400), ']', err);
  }
}

// ============================================================
// 3. TIME TRACKING ENGINE
// ============================================================
function getTodayKey() {
  // Use locale date string for timezone-aware day boundary
  return new Date().toLocaleDateString('zh-CN');
}

// The daily quota is elapsed wall-clock time, never "how many times this
// function ran". usageClock is the single settlement point: it remembers when
// the tracker last looked and which timed rule was in front of the user, and
// every trigger (the 1-minute alarm, a tab switch, a page finishing its load)
// only closes the interval that has elapsed since then.
//
// Two rules make that safe:
//   - An interval longer than USAGE_MAX_GAP_MS is not charged at all. The
//     machine slept, the browser was closed or the worker was parked, so nobody
//     was looking at the page and there is nothing to charge for.
//   - Only the gap between two observations is ever charged, so five triggers
//     inside the same second charge five times ~0s instead of five minutes.
const USAGE_MAX_GAP_MS = 2 * TRACKING_INTERVAL_SEC * 1000;

function emptyUsageClock(now) {
  return { at: now, domain: null, limitMin: 0 };
}

// A clock we cannot trust (missing, corrupt, dated in the future) starts over
// at `now` with nothing on the meter: that charges zero and loses nothing.
function usageClockFrom(raw, now) {
  const clock = (raw && typeof raw === 'object') ? raw : {};
  const at = Number(clock.at);
  if (!isFinite(at) || at <= 0 || at > now) return emptyUsageClock(now);
  const domain = (typeof clock.domain === 'string' && clock.domain) ? clock.domain : null;
  const limitMin = Number(clock.limitMin);
  return {
    at: at,
    domain: domain,
    limitMin: (isFinite(limitMin) && limitMin > 0) ? limitMin : 30
  };
}

// Milliseconds worth charging for the interval that just ended.
function creditForInterval(clock, now) {
  if (!clock.domain) return 0;
  const elapsed = now - clock.at;
  if (!isFinite(elapsed) || elapsed <= 0) return 0;
  if (elapsed > USAGE_MAX_GAP_MS) return 0;
  return elapsed;
}

// The timed rule that owns this host, or null. An excepted host never matches:
// the user said not to apply their rules there, and the daily quota is one of
// them.
function timedRuleForHost(items, host, date) {
  if (isExceptedHost(items, host)) return null;
  const now = date || new Date();
  for (const item of items) {
    if (isException(item)) continue;
    if (!ruleWindowActive(item, now)) continue;
    if (item.type === 'timed' && item.mode === 'website' && hostMatches(host, item.val)) {
      return item;
    }
  }
  return null;
}

async function trackActiveTab() {
  try {
    const now = Date.now();
    const today = getTodayKey();
    const local = await chrome.storage.local.get([
      STORAGE_KEYS.DAILY_USAGE, STORAGE_KEYS.USAGE_CLOCK
    ]);
    const dailyUsage = local[STORAGE_KEYS.DAILY_USAGE] || {};
    const clock = usageClockFrom(local[STORAGE_KEYS.USAGE_CLOCK], now);

    // 3a. Ensure today's entry exists
    const dayIsNew = !dailyUsage[today];
    if (dayIsNew) dailyUsage[today] = {};

    // Clean up old dates (keep only yesterday + today, max 2 entries)
    const keys = Object.keys(dailyUsage).sort();
    while (keys.length > 2) {
      delete dailyUsage[keys.shift()];
    }

    // 3b. Work out which timed rule owns the tab in front of the user
    let matched = null;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.url) {
      const { [STORAGE_KEYS.BLOCKED_ITEMS]: storedItems } =
        await chrome.storage.sync.get([STORAGE_KEYS.BLOCKED_ITEMS]);
      const items = storedItems || [];
      // A window opening or closing changes what is blocked, and this per-minute
      // tick is the only thing that runs often enough to notice.
      if (windowSignatureOf(items) !== lastWindowSignature) {
        await syncAllRules();
      }
      matched = timedRuleForHost(items, hostOfUrl(tab.url));
    }

    // 3c. Close the interval that just ended, then open the new one
    const charged = creditForInterval(clock, now);
    const settledDomain = clock.domain;
    const settledLimitMin = clock.limitMin;
    const prevMs = settledDomain ? (dailyUsage[today][settledDomain] || 0) : 0;
    if (charged > 0) dailyUsage[today][settledDomain] = prevMs + charged;

    // The clock and the total are written together: a stale clock would charge
    // the next interval to the wrong site for the wrong amount.
    await chrome.storage.local.set({
      [STORAGE_KEYS.DAILY_USAGE]: dailyUsage,
      [STORAGE_KEYS.USAGE_CLOCK]: {
        at: now,
        domain: matched ? matched.val : null,
        limitMin: matched ? (matched.limitMin || 30) : 0
      }
    });

    // A new day clears every quota rule, so recompute the whole set once.
    if (dayIsNew) await syncAllRules();

    if (charged > 0) {
      const limitMs = settledLimitMin * 60 * 1000;
      const newMs = dailyUsage[today][settledDomain];

      // 3d. Check if just exceeded limit → enforce
      if (prevMs < limitMs && newMs >= limitMs) {
        console.log('[Blocker] Time limit reached for', settledDomain);
        await enforceTimeLimit(settledDomain, settledLimitMin);
      }

      // 3e. Warning at 5 minutes remaining
      const remainingMs = limitMs - newMs;
      if (remainingMs > 0 && remainingMs <= 5 * 60 * 1000 && prevMs > limitMs - 6 * 60 * 1000) {
        showWarningNotification(settledDomain, Math.ceil(remainingMs / 60000));
      }
    }
  } catch (err) {
    // Tab query can fail if no window is focused — non-critical
    console.debug('[Blocker] trackActiveTab skipped:', err.message);
  }
}

// Enforcing a quota is not a second rule writer: syncAllRulesNow already puts a
// rule in for every timed site that is at or over its limit for the day, so
// recomputing the whole set is enough here. Keeping exactly one writer is what
// makes the "clear the ids we are about to reuse" step trustworthy.
function enforceTimeLimit(domain, limitMin) {
  return withDnrLock(async () => {
    await syncAllRulesNow();
    await redirectActiveTabAway(domain);
    console.log('[Blocker] Enforced time limit for', domain, '(', limitMin, 'min)');
  });
}

// DNR only sees requests that have not been made yet, so a tab that is already
// sitting on the domain has to be sent to the block page by hand.
async function redirectActiveTabAway(domain) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.url && hostMatches(hostOfUrl(tab.url), domain)) {
      await chrome.tabs.update(tab.id, {
        url: chrome.runtime.getURL('blockpage.html?host=' + encodeURIComponent(domain) +
          '&url=' + encodeURIComponent(tab.url))
      });
    }
  } catch (e) {
    console.debug('[Blocker] Could not redirect active tab:', e.message);
  }
}

// The last chance to wrap up before a timed site closes. This used to be a
// bare console.log, so the first the user heard about it was the block page.
// The notifications permission and the whole channel were already here for the
// pomodoro phases; this only uses them.
function showWarningNotification(domain, remainingMin) {
  if (!notificationsAvailable()) return;
  try {
    chrome.notifications.create(QUOTA_WARNING_NOTIFY_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon.png'),
      title: 'Time limit almost up',
      message: domain + ' has ' + remainingMin + ' min left today.'
    });
  } catch (err) {
    console.debug('[Blocker] Quota warning skipped:', err.message);
  }
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
  await chrome.storage.local.set({
    [STORAGE_KEYS.DAILY_USAGE]: dailyUsage,
    // The clock is reset with the totals: the interval that was open at
    // midnight belongs to the day that just ended.
    [STORAGE_KEYS.USAGE_CLOCK]: emptyUsageClock(Date.now())
  });

  // The rules follow from the usage that was just cleared: syncAllRulesNow
  // drops every quota rule on its own and keeps whatever a focus session is
  // pinning, so there is no separate removal that could disagree with the next
  // sync about what is on.
  await syncAllRulesNow();

  console.log('[Blocker] Daily reset complete.');
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
  focusBlocksTimed: true,
  // Off by default: a tool that beeps before the user asked it to is a tool
  // they uninstall.
  soundOn: false
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
  strictNow: false,
  // The one pause a focus session gets: pauseUsed is spent on the first pause
  // and handed back at the next phase change, pauseEndsAt is when the frozen
  // clock starts itself again (0 = not a limited pause).
  pauseUsed: false,
  pauseEndsAt: 0,
  // A run is the multi-unit commitment the user starts from a task row:
  // { taskId, units, focusDone }. It survives worker recycling because it is
  // part of the state, and it is what makes the timer keep going on its own.
  run: null,
  // Pending question: { taskId, at } - the task reached its planned units, ask
  // whether the work is actually finished. Cleared by answering it.
  review: null
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
  s.soundOn = !!s.soundOn;
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
  // cannot negotiate with it. Only an explicit stop leaves focus mode - a focus
  // session cannot be skipped at all (see pomodoroSkip).
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
  if (paused) {
    // A limited pause has no session deadline to wait for, but the worker still
    // has to wake up when the allowance runs out - that is what restarts the
    // clock. Without this the resume would wait for the 1-minute tracking tick.
    if (state.pauseEndsAt > 0) chrome.alarms.create(POMODORO_ALARM, { when: state.pauseEndsAt });
    return;
  }
  if (state.phase !== 'idle' && state.endAt > 0) {
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

// A service worker cannot play audio, so the chime needs an offscreen
// document. Every step is optional: a Chrome without the offscreen API, or a
// document that cannot be created, simply means no sound.
const OFFSCREEN_PATH = 'offscreen.html';

async function ensureOffscreen() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return false;
  try {
    if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return true;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play a short chime when a focus session or a break ends.'
    });
    return true;
  } catch (err) {
    // Two workers racing to create it is the one failure that is harmless.
    if (/single offscreen/i.test(String((err && err.message) || ''))) return true;
    console.debug('[Blocker] Offscreen document unavailable:', err.message);
    return false;
  }
}

async function playPhaseSound(fromPhase) {
  try {
    if (!(await ensureOffscreen())) return;
    chrome.runtime.sendMessage({ action: 'playChime', kind: fromPhase }, function () {
      // The offscreen document does not answer; reading lastError keeps Chrome
      // from logging an unchecked-error warning.
      void chrome.runtime.lastError;
    });
  } catch (err) {
    console.debug('[Blocker] Chime skipped:', err.message);
  }
}

// Exactly one transition per call, and credit is false for skip (the session
// is not counted). The next phase always starts from `now`, never from the
// stale deadline: a session that expired three hours ago advances exactly one
// phase and credits exactly one, never a chain of them.
async function pomodoroEnterNextPhase(state, settings, now, credit) {
  const from = state.phase;
  let next = 'idle';
  // A run is an explicit commitment to N units, so it keeps itself going even
  // when the auto-start settings are off - that is what "run until it is done"
  // means. Breaks stay skippable; focus does not (see pomodoroSkip).
  const run = (state.run && state.run.taskId) ? state.run : null;

  if (from === 'focus') {
    if (credit) {
      state.cycleDone += 1;
      state.focusToday += 1;
      state.focusMsToday += settings.focusMin * 60 * 1000;
      await creditTaskFocus(run ? run.taskId : state.taskId, settings.focusMin);
      if (run) run.focusDone = (run.focusDone || 0) + 1;
    }
    const cycles = Math.max(1, settings.cyclesUntilLongBreak);
    // A skipped focus has nothing to show for it, so it must never earn the
    // long break: cycleDone stays put, and 0 % cycles === 0 would otherwise
    // hand out a long break on the very first skip.
    const longBreakDue = credit && state.cycleDone > 0 && (state.cycleDone % cycles === 0);
    next = longBreakDue ? 'longBreak' : 'shortBreak';
    if (!settings.autoStartBreak && !run) next = 'idle';
  } else if (from === 'shortBreak' || from === 'longBreak') {
    // A long break closes the cycle, whether it ran out or was skipped.
    if (from === 'longBreak') state.cycleDone = 0;
    if (run) {
      if ((run.focusDone || 0) < run.units) {
        next = 'focus';
      } else {
        // The run is spent: its last unit ended with this break. Ask about the
        // task only now, so the unit the user planned really did include the
        // break they just took.
        state.run = null;
        next = 'idle';
        await maybeOpenReview(state, run.taskId);
      }
    } else {
      next = settings.autoStartFocus ? 'focus' : 'idle';
    }
  }

  state.pausedRemainingMs = null;
  // A new phase hands the pause back: the next focus gets its own one.
  state.pauseUsed = false;
  state.pauseEndsAt = 0;

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
    if (state.phase === 'idle') return { changed: false };
    if (paused) {
      // The pause has run out: the clock starts itself again with the frozen
      // remainder, from `now` and never from the deadline it was frozen at -
      // a machine that slept through the pause must not come back to a session
      // that finished while nobody was working.
      if (!state.pauseEndsAt || now < state.pauseEndsAt) return { changed: false };
      state.endAt = now + state.pausedRemainingMs;
      state.pausedRemainingMs = null;
      state.pauseEndsAt = 0;
      await writePomodoroState(state);
      return { changed: true };
    }
    if (!state.endAt || now < state.endAt) return { changed: false };

    const settings = await getPomodoroSettings();
    const lateMs = now - state.endAt;
    const fromPhase = state.phase;
    await pomodoroEnterNextPhase(state, settings, now, true);
    await writePomodoroState(state, settings);
    notifyPomodoroPhase(fromPhase, state.phase, lateMs, settings);
    // Not awaited: a chime must never hold up the transition, and a failed one
    // must never turn into an unhandled rejection.
    if (settings.soundOn) playPhaseSound(fromPhase).catch(() => {});
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
    // The page shows how long the pause may last, so the limit is sent with the
    // state instead of being written out a second time in the UI.
    pauseMaxMs: POMODORO_MAX_PAUSE_MS,
    notifications: notificationsAvailable()
  };
}

// `units` starts a planned run on that task - N units, and a review question
// when the task's estimate is reached. Without `units` this is the plain single
// session the Start button has always started.
async function pomodoroStart(taskId, units, planUnits) {
  const [settings, state] = await Promise.all([getPomodoroSettings(), getPomodoroState()]);
  const now = Date.now();
  // No taskId in the message means keep the current selection; an explicit
  // null means clear it.
  if (taskId !== undefined) state.taskId = taskId || null;

  let run = null;
  if (state.taskId && units !== undefined && units !== null) {
    if (planUnits !== undefined && planUnits !== null) {
      await setTaskPlan(state.taskId, planUnits);
    }
    run = { taskId: state.taskId, units: sanitizeUnits(units, 1), focusDone: 0 };
    // Starting a run on the task the question is about answers that question by
    // acting on it; a plain session leaves it pending.
    if (state.review && state.review.taskId === run.taskId) state.review = null;
  }

  state.run = run;
  state.phase = 'focus';
  state.startedAt = now;
  state.endAt = now + settings.focusMin * 60 * 1000;
  state.pausedRemainingMs = null;
  state.pauseUsed = false;
  state.pauseEndsAt = 0;
  return writePomodoroState(state, settings);
}

async function pomodoroPause() {
  const state = await getPomodoroState();
  const paused = state.pausedRemainingMs !== null && state.pausedRemainingMs !== undefined;
  if (state.phase === 'idle' || paused) return writePomodoroState(state);
  // One pause per focus session, and it expires on its own (see pomodoroTick).
  // Breaks are left unlimited: the promise of this tool is about the work.
  if (state.phase === 'focus' && state.pauseUsed) return writePomodoroState(state);
  const now = Date.now();
  state.pausedRemainingMs = Math.max(0, state.endAt - now);
  state.endAt = 0;
  if (state.phase === 'focus') {
    state.pauseUsed = true;
    state.pauseEndsAt = now + POMODORO_MAX_PAUSE_MS;
  }
  return writePomodoroState(state);
}

async function pomodoroResume() {
  const state = await getPomodoroState();
  const paused = state.pausedRemainingMs !== null && state.pausedRemainingMs !== undefined;
  if (state.phase === 'idle' || !paused) return writePomodoroState(state);
  state.endAt = Date.now() + state.pausedRemainingMs;
  state.pausedRemainingMs = null;
  state.pauseEndsAt = 0;
  return writePomodoroState(state);
}

// Skip moves on without recording anything. Stop drops back to idle and keeps
// the cycle position: both are user decisions, not tamper signals.
//
// Focus is deliberately NOT skippable - the promise of the timer is that a
// running session has to be seen through, and Stop is the honest way out (it
// records nothing). Breaks stay skippable, including the last break of a run,
// which is how you get to the "is it finished?" question early.
async function pomodoroSkip() {
  const state = await getPomodoroState();
  if (state.phase === 'idle' || state.phase === 'focus') return writePomodoroState(state);
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
  state.pauseEndsAt = 0;
  // Giving up on the session gives up on its run as well: the units it had left
  // were never spent and nothing was credited for the part that did run.
  state.run = null;
  return writePomodoroState(state);
}

// The three answers to "is this finished?". Only 'done' touches the task;
// 'continue' just clears the question, and the page then asks how many more
// units to plan (that answer comes back through pomodoroStart).
async function pomodoroReviewAnswer(mode) {
  const state = await getPomodoroState();
  const review = state.review;
  if (!review) return writePomodoroState(state);
  if (mode === 'done') await setTaskDone(review.taskId, true);
  state.review = null;
  return writePomodoroState(state);
}

// --- todo list ---

function normalizeTodo(raw) {
  const todo = (raw && typeof raw === 'object') ? raw : {};
  if (!Array.isArray(todo.tasks)) todo.tasks = [];
  // Tasks written before plans existed have no plannedUnits; treat every
  // missing/garbage value as "no estimate yet" instead of NaN arithmetic.
  for (const task of todo.tasks) {
    if (!task) continue;
    const planned = Number(task.plannedUnits);
    task.plannedUnits = (isFinite(planned) && planned > 0) ? Math.round(planned) : 0;
  }
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

// --- task plans and runs -------------------------------------------------
// A unit is one focus session plus its break - the block the user plans in -
// so everything here counts units, never milliseconds.

function sanitizeUnits(value, fallback) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.min(99, Math.max(1, Math.round(n)));
}

function taskPlannedUnits(task) {
  const n = Number(task && task.plannedUnits);
  return (isFinite(n) && n > 0) ? Math.round(n) : 0;
}

function taskCreditedUnits(task) {
  const n = Number(task && task.pomodoros);
  return (isFinite(n) && n > 0) ? Math.round(n) : 0;
}

// The estimate may be raised or lowered, but never below the work already
// recorded for the task: that would make "the estimate is reached" - the moment
// the review question fires - impossible to get to again.
async function setTaskPlan(taskId, units) {
  const todo = await getTodo();
  const task = findTask(todo, taskId);
  if (!task) return null;
  const planned = Math.max(taskCreditedUnits(task),
    sanitizeUnits(units, taskPlannedUnits(task) || 1));
  task.plannedUnits = planned;
  await saveTodo(todo);
  return task;
}

async function setTaskDone(taskId, done) {
  const todo = await getTodo();
  const task = findTask(todo, taskId);
  if (!task) return null;
  if (!!task.done !== !!done) {
    task.done = !!done;
    task.doneAt = done ? Date.now() : 0;
  }
  await saveTodo(todo);
  return task;
}

// Reaching the estimate is the moment to ask instead of rolling on silently. A
// task that was deleted mid-run simply has nobody to ask.
async function maybeOpenReview(state, taskId) {
  if (!taskId) return;
  const todo = await getTodo();
  const task = findTask(todo, taskId);
  if (!task) return;
  const planned = taskPlannedUnits(task);
  if (planned > 0 && taskCreditedUnits(task) >= planned) {
    state.review = { taskId: taskId, at: Date.now() };
  }
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
    focusMs: 0,
    plannedUnits: 0
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
    if (id === POMODORO_NOTIFY_ID || id === QUOTA_WARNING_NOTIFY_ID) {
      chrome.notifications.clear(id);
    }
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
// 7b. KEYBOARD SHORTCUTS
//
// Reducing friction is the whole point of a tool like this: the two things a
// user does most often should not need the mouse.
// ============================================================
async function openPomodoroWindow() {
  const url = chrome.runtime.getURL('pomodoro.html');
  try {
    // One window, never two: focusing the existing one beats opening a
    // duplicate the user then has to close.
    const wins = await chrome.windows.getAll({ populate: true });
    for (const win of wins || []) {
      for (const tab of (win.tabs || [])) {
        if ((tab.url || '').indexOf('pomodoro.html') !== -1) {
          await chrome.windows.update(win.id, { focused: true });
          return;
        }
      }
    }
    await chrome.windows.create({ url: url, type: 'popup', width: 460, height: 660 });
  } catch (err) {
    console.debug('[Blocker] Could not open the pomodoro window:', err.message);
  }
}

async function togglePomodoroTimer() {
  const state = await getPomodoroState();
  if (state.phase === 'idle') return;
  const paused = state.pausedRemainingMs !== null && state.pausedRemainingMs !== undefined;
  // A focus session only has the one pause, and the worker refuses a second
  // one; the shortcut must not become a way around that.
  if (paused) await pomodoroResume();
  else await pomodoroPause();
  await pomodoroAfterChange();
}

// chrome.commands is absent in the test harness and can be missing on a Chrome
// that does not support a suggested key, so register defensively.
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'open-pomodoro') {
      openPomodoroWindow();
    } else if (command === 'toggle-timer') {
      togglePomodoroTimer().catch(err => console.warn('[Blocker] Shortcut skipped:', err));
    }
  });
}

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
  } else if (alarm.name === TEMP_UNLOCK_ALARM) {
    // An unlock ran out: drop it and let the rules follow.
    expireTempUnlocks()
      .then(() => syncAllRules())
      .then(() => armTempUnlockAlarm())
      .catch(err => console.warn('[Blocker] Temp unlock cleanup skipped:', err));
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
      case 'getTempUnlocks': {
        sendResponse({ success: true, tempUnlocks: await getTempUnlocks() });
        break;
      }
      case 'tempUnlock': {
        await tempUnlock(message.val, message.minutes);
        await syncAllRules();
        await trackActiveTab();
        sendResponse({ success: true, tempUnlocks: await getTempUnlocks() });
        break;
      }
      case 'pomodoroGetState': {
        sendResponse(Object.assign({ success: true }, await pomodoroStatus()));
        break;
      }
      case 'pomodoroStart': {
        await pomodoroStart(message.taskId, message.units, message.planUnits);
        await pomodoroAfterChange();
        sendResponse(Object.assign({ success: true, tasks: (await getTodo()).tasks },
          await pomodoroStatus()));
        break;
      }
      case 'pomodoroReviewAnswer': {
        await pomodoroReviewAnswer(message.mode);
        await pomodoroAfterChange();
        sendResponse(Object.assign({ success: true, tasks: (await getTodo()).tasks },
          await pomodoroStatus()));
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

  // A temporary unlock outlives the worker, so the alarm that re-locks the site
  // has to be re-armed on every start, not only when the unlock was granted.
  try {
    await expireTempUnlocks();
    await armTempUnlockAlarm();
  } catch (err) {
    console.warn('[Blocker] Temp unlock startup skipped:', err.message);
  }

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
