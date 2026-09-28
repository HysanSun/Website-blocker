// ============================================================
// Harness: drives background.js through simulated MV3 service-worker
// lifetimes and checks the pomodoro + todo behaviour.
//
// Usage: node test/pomodoro-harness.js <path-to-background.js> [label]
//
// Same philosophy as test/streak-harness.js: a scenario must be able to FAIL
// on a broken implementation, so every expectation below is about an
// observable outcome (stored state, DNR rules, notifications), not internals.
// ============================================================
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = process.argv[2];
const LABEL = process.argv[3] || SRC;
const code = fs.readFileSync(SRC, 'utf8');

const MIN = 60 * 1000;
// Anchor the simulated clock at 12:00 local. Scenarios fast-forward by hours,
// and the daily counters reset on the day key, so running the suite at 23:40
// must not turn a three-hour jump into a day rollover.
const T0 = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
})();

// --- controllable clock ---------------------------------------------------
// The worker only ever asks for Date.now() or `new Date()`, so a Date subclass
// pinned to NOW is enough to fast-forward days of behaviour in a test.
let NOW = T0;
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(NOW); else super(...args);
  }
  static now() { return NOW; }
}
function todayKey() { return new FakeDate().toLocaleDateString('zh-CN'); }
function advance(ms) { NOW += ms; }

// --- chrome.storage areas -------------------------------------------------
function makeStores() { return { local: {}, session: {}, sync: {} }; }

function area(store) {
  const pick = (keys) => {
    const list = Array.isArray(keys) ? keys
      : typeof keys === 'string' ? [keys]
        : Object.keys(keys || {});
    const out = {};
    for (const k of list) if (k in store) out[k] = store[k];
    return out;
  };
  return {
    get(keys, cb) {
      const p = Promise.resolve(pick(keys));
      if (cb) p.then(cb);
      return p;
    },
    set(items, cb) {
      Object.assign(store, items);
      const p = Promise.resolve();
      if (cb) p.then(cb);
      return p;
    },
  };
}

async function drain(n) {
  const count = n || 100;
  for (let i = 0; i < count; i++) await new Promise((r) => setImmediate(r));
}

// --- one service-worker lifetime -----------------------------------------
function runLifetime(stores, opts) {
  const hostAccess = (opts && 'hostAccess' in opts) ? opts.hostAccess : true;
  const logs = [];
  const timers = [];
  const notifs = [];
  const alarmCalls = [];
  const badge = { text: null, color: null };
  let dnrRules = [];
  // Simulates a dying worker landing one last rule write during a reload.
  let sneakRuleId = (opts && 'sneakRuleId' in opts) ? opts.sneakRuleId : null;
  const L = { startup: [], installed: [], alarm: [], message: [], activated: [], updated: [] };

  const chrome = {
    action: {
      setBadgeText: async (o) => { badge.text = o && o.text; },
      setBadgeBackgroundColor: async (o) => { badge.color = o && o.color; },
    },
    alarms: {
      create: (name, info) => { alarmCalls.push({ name, info }); },
      clear: async (name) => { alarmCalls.push({ name, clear: true }); return true; },
      onAlarm: { addListener: (fn) => L.alarm.push(fn) },
    },
    storage: {
      local: area(stores.local),
      session: area(stores.session),
      sync: area(stores.sync),
    },
    declarativeNetRequest: {
      // Real DNR is an async round trip to the browser process, so overlapping
      // callers interleave. Modelling that - plus the unique-id rule - is what
      // lets P15/P16 fail on an unserialized implementation.
      getDynamicRules: async () => {
        await new Promise((r) => setImmediate(r));
        return dnrRules.slice();
      },
      updateDynamicRules: async (o) => {
        await new Promise((r) => setImmediate(r));
        if (sneakRuleId !== null) {
          dnrRules = dnrRules.concat([{ id: sneakRuleId, priority: 10, action: {}, condition: {} }]);
          sneakRuleId = null;
        }
        const remove = (o && o.removeRuleIds) || [];
        const add = (o && o.addRules) || [];
        const next = remove.length ? dnrRules.filter((r) => remove.indexOf(r.id) === -1) : dnrRules.slice();
        for (const rule of add) {
          if (next.some((r) => r.id === rule.id)) {
            throw new Error('Rule with id ' + rule.id + ' does not have a unique ID.');
          }
        }
        dnrRules = next.concat(add);
      },
    },
    tabs: {
      query: async () => [],
      update: async () => {},
      onActivated: { addListener: (fn) => L.activated.push(fn) },
      onUpdated: { addListener: (fn) => L.updated.push(fn) },
    },
    runtime: {
      getManifest: () => ({ version: '0.0.0-test' }),
      getURL: (path) => 'chrome-extension://test/' + path,
      onMessage: { addListener: (fn) => L.message.push(fn) },
      onStartup: { addListener: (fn) => L.startup.push(fn) },
      onInstalled: { addListener: (fn) => L.installed.push(fn) },
    },
    permissions: {
      contains: (_q, cb) => { if (cb) cb(hostAccess); return Promise.resolve(hostAccess); },
    },
    notifications: {
      create: (id, options) => { notifs.push({ id, options }); },
      clear: async () => {},
      onClicked: { addListener: () => {} },
    },
  };

  // Chrome only exposes this namespace once the permission has actually been
  // granted, so the worker has to cope with it being absent.
  if (opts && opts.noNotifications) delete chrome.notifications;

  const sandbox = {
    chrome,
    console: {
      log: (...a) => logs.push(a.join(' ')),
      debug: () => {},
      warn: (...a) => logs.push('WARN ' + a.join(' ')),
      error: (...a) => logs.push('ERROR ' + a.join(' ')),
    },
    // Only the startup grace delay uses a timer; queue it so lifecycle events
    // can be dispatched first, exactly as Chrome does.
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    Date: FakeDate,
    Promise, JSON, Math, Object, Array, String, Number, Boolean,
    Error, RegExp, isNaN, isFinite, parseInt, parseFloat, Set, Map, Symbol,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // initialize() chains several async round trips (storage, DNR, alarms) and
  // the DNR stub models Chrome's real async round trip, so a worker is not
  // quiet after one or two turns. Wait for a run of idle turns instead of a
  // fixed count; nothing here advances the clock, so extra turns are harmless.
  async function settle() {
    let idle = 0;
    for (let i = 0; i < 800 && idle < 12; i++) {
      await new Promise((r) => setImmediate(r));
      if (timers.length) {
        idle = 0;
        timers.shift()();
      } else {
        idle++;
      }
    }
  }

  return {
    logs,
    notifs,
    badge,
    alarmCalls,
    getRules: () => dnrRules.slice(),
    settle,
    fireStartup: () => L.startup.forEach((fn) => fn()),
    fireInstalled: (reason) => L.installed.forEach((fn) => fn({ reason })),
    fireAlarm: (name) => L.alarm.forEach((fn) => fn({ name })),
    sendMessage: async (msg) => {
      let out;
      if (L.message.length === 0) return undefined;
      L.message[0](msg, {}, (r) => { out = r; });
      await drain();
      return out;
    },
  };
}

// --- seed -----------------------------------------------------------------
// A live extension: an existing streak, a session marker (so the streak logic
// stays quiet), plus whatever pomodoro / todo state the scenario needs.
function seed(o) {
  const s = makeStores();
  s.local.startDate = T0 - 3 * 24 * 60 * MIN;
  s.local.lastHeartbeat = T0;
  s.local.hadHostAccess = true;
  s.session.swAlive = T0;
  s.local.pomodoro = Object.assign({
    v: 1, phase: 'idle', endAt: 0, startedAt: 0, pausedRemainingMs: null,
    cycleDone: 0, dayKey: todayKey(), focusToday: 0, focusMsToday: 0,
    taskId: null, strictNow: false
  }, (o && o.pomodoro) || {});
  s.local.todo = { v: 1, tasks: (o && o.tasks) || [] };
  s.sync.pomodoroSettings = Object.assign({}, (o && o.settings) || {});
  s.sync.blockedItems = (o && o.rules) || [];
  s.local.dailyUsage = (o && o.dailyUsage) || {};
  if (!s.local.dailyUsage[todayKey()]) s.local.dailyUsage[todayKey()] = {};
  return s;
}

function snap(s) { return JSON.parse(JSON.stringify(s.local.pomodoro)); }

// --- scenarios ------------------------------------------------------------
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}

const scenarios = [
  {
    name: 'P1 focus expires -> short break, session credited to the task',
    run: async () => {
      NOW = T0;
      const s = seed({
        tasks: [{ id: 't1', text: 'Write the report', done: false, createdAt: T0, doneAt: 0, pomodoros: 0, focusMs: 0 }],
        pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0, taskId: 't1' },
      });
      const life = runLifetime(s);
      await life.settle();
      advance(25 * MIN + 20 * 1000);
      life.fireAlarm('tracking');
      await drain();
      return { s };
    },
    expect: (r) => {
      const p = r.s.local.pomodoro;
      const t = r.s.local.todo.tasks[0];
      const ok = p.phase === 'shortBreak' && p.focusToday === 1 && p.cycleDone === 1 &&
        p.focusMsToday === 25 * MIN && t.pomodoros === 1 && t.focusMs === 25 * MIN &&
        p.endAt === NOW + 5 * MIN && p.strictNow === false;
      return [ok, 'phase=' + p.phase + ' focusToday=' + p.focusToday + ' cycleDone=' + p.cycleDone +
        ' taskPomos=' + t.pomodoros + ' breakLen=' + ((p.endAt - NOW) / MIN) + 'min strictNow=' + p.strictNow];
    },
  },
  {
    name: 'P2 worker recycled mid-focus: deadline intact, nothing credited',
    run: async () => {
      NOW = T0;
      const endAt = T0 + 25 * MIN;
      const s = seed({ pomodoro: { phase: 'focus', endAt: endAt, startedAt: T0 } });
      const life = runLifetime(s);
      await life.settle();
      advance(10 * MIN);
      life.fireAlarm('tracking');
      await drain();
      return { s, endAt };
    },
    expect: (r) => {
      const p = r.s.local.pomodoro;
      const ok = p.phase === 'focus' && p.endAt === r.endAt && p.focusToday === 0 && p.cycleDone === 0;
      return [ok, 'phase=' + p.phase + ' endAtUnchanged=' + (p.endAt === r.endAt) + ' focusToday=' + p.focusToday];
    },
  },
  {
    name: 'P3 fourth focus -> long break; long break closes the cycle',
    run: async () => {
      NOW = T0;
      const s = seed({ pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0, cycleDone: 3 } });
      const life = runLifetime(s);
      await life.settle();
      advance(25 * MIN + 5 * 1000);
      const focusEndedAt = NOW;
      life.fireAlarm('pomodoroPhase');
      await drain();
      const afterFocus = snap(s);
      NOW = afterFocus.endAt + 1000;
      life.fireAlarm('pomodoroPhase');
      await drain();
      return { s, afterFocus, focusEndedAt };
    },
    expect: (r) => {
      const p = r.s.local.pomodoro;
      const ok = r.afterFocus.phase === 'longBreak' && r.afterFocus.cycleDone === 4 &&
        r.afterFocus.focusToday === 1 && r.afterFocus.endAt === r.focusEndedAt + 15 * MIN &&
        p.phase === 'idle' && p.cycleDone === 0;
      return [ok, 'afterFocus=' + r.afterFocus.phase + '/cycle' + r.afterFocus.cycleDone +
        '/len' + ((r.afterFocus.endAt - r.focusEndedAt) / MIN) + 'min then ' + p.phase +
        '/cycle' + p.cycleDone];
    },
  },
  {
    name: 'P4 wall clock: 3h late still credits exactly one session, no cascade',
    run: async () => {
      NOW = T0;
      const s = seed({
        tasks: [{ id: 't1', text: 'Deep work', done: false, createdAt: T0, doneAt: 0, pomodoros: 0, focusMs: 0 }],
        pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0, taskId: 't1' },
      });
      const life = runLifetime(s);
      await life.settle();
      advance(3 * 60 * MIN);
      life.fireAlarm('tracking');
      await drain();
      return { s };
    },
    expect: (r) => {
      const p = r.s.local.pomodoro;
      const ok = p.phase === 'shortBreak' && p.focusToday === 1 && p.cycleDone === 1 &&
        p.endAt === NOW + 5 * MIN;
      return [ok, 'phase=' + p.phase + ' focusToday=' + p.focusToday + ' cycleDone=' + p.cycleDone +
        ' nextLen=' + ((p.endAt - NOW) / MIN) + 'min'];
    },
  },
  {
    name: 'P5 pause freezes, resume recomputes, skip and stop record nothing',
    run: async () => {
      NOW = T0;
      const s = seed({ pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0 } });
      const life = runLifetime(s);
      await life.settle();
      await life.sendMessage({ action: 'pomodoroPause' });
      const paused = snap(s);
      advance(10 * MIN);
      life.fireAlarm('tracking');
      await drain();
      const stillPaused = snap(s);
      await life.sendMessage({ action: 'pomodoroResume' });
      const resumed = snap(s);
      await life.sendMessage({ action: 'pomodoroSkip' });
      const skipped = snap(s);
      await life.sendMessage({ action: 'pomodoroStop' });
      const stopped = snap(s);
      return { paused, stillPaused, resumed, skipped, stopped };
    },
    expect: (r) => {
      const ok = r.paused.pausedRemainingMs === 25 * MIN && r.paused.endAt === 0 &&
        r.stillPaused.phase === 'focus' && r.stillPaused.pausedRemainingMs === 25 * MIN &&
        r.resumed.endAt === T0 + 10 * MIN + 25 * MIN && r.resumed.pausedRemainingMs === null &&
        r.skipped.phase === 'shortBreak' && r.skipped.focusToday === 0 && r.skipped.cycleDone === 0 &&
        r.stopped.phase === 'idle';
      return [ok, 'paused=' + r.paused.pausedRemainingMs + ' stillPaused=' + r.stillPaused.phase +
        ' resumedIn=' + ((r.resumed.endAt - (T0 + 10 * MIN)) / MIN) + 'min skip=' + r.skipped.phase +
        '/today' + r.skipped.focusToday + ' stop=' + r.stopped.phase];
    },
  },
  {
    name: 'P6 disable -> enable voids the session and leaves the streak to its own rules',
    run: async () => {
      NOW = T0;
      const s = seed({ pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0 } });
      const startDateBefore = s.local.startDate;
      delete s.session.swAlive;
      const life = runLifetime(s);
      await life.settle();
      return { s, startDateBefore };
    },
    expect: (r) => {
      const ok = r.s.local.pomodoro.phase === 'idle' && r.s.local.needsAlert === true &&
        r.s.local.startDate > r.startDateBefore;
      return [ok, 'pomodoro=' + r.s.local.pomodoro.phase + ' needsAlert=' + !!r.s.local.needsAlert +
        ' streakReset=' + (r.s.local.startDate > r.startDateBefore)];
    },
  },
  {
    name: 'P7 day rollover clears the counters but keeps the cycle and the tasks',
    run: async () => {
      NOW = T0;
      const yesterday = new FakeDate(T0 - 24 * 60 * MIN).toLocaleDateString('zh-CN');
      const s = seed({
        pomodoro: { phase: 'idle', cycleDone: 2, dayKey: yesterday, focusToday: 3, focusMsToday: 90 * MIN },
        tasks: [{ id: 'a', text: 'Shipped', done: true, createdAt: T0, doneAt: T0, pomodoros: 2, focusMs: 50 * MIN }],
      });
      const life = runLifetime(s);
      await life.settle();
      const res = await life.sendMessage({ action: 'pomodoroGetState' });
      return { res, s };
    },
    expect: (r) => {
      const st = r.res.state;
      const ok = st.focusToday === 0 && st.focusMsToday === 0 && st.cycleDone === 2 &&
        st.dayKey === todayKey() && r.s.local.todo.tasks.length === 1 && r.s.local.todo.tasks[0].done === true;
      return [ok, 'focusToday=' + st.focusToday + ' focusMsToday=' + st.focusMsToday +
        ' cycleDone=' + st.cycleDone + ' tasks=' + r.s.local.todo.tasks.length];
    },
  },
  {
    name: 'P8 focus blocks every timed site; leaving focus restores the real quota',
    run: async () => {
      NOW = T0;
      const rules = [
        { val: 'bilibili.com', mode: 'website', type: 'timed', limitMin: 30 },
        { val: 'youtube.com', mode: 'website', type: 'timed', limitMin: 60 },
        { val: 'ghcis.com', mode: 'website', type: 'block' },
      ];
      const dailyUsage = {};
      dailyUsage[todayKey()] = { 'youtube.com': 60 * MIN };
      const s = seed({ rules, dailyUsage });
      const life = runLifetime(s);
      await life.settle();
      const ids = () => life.getRules().map((r) => r.id).sort((a, b) => a - b).join(',');
      const idleRules = ids();
      await life.sendMessage({ action: 'pomodoroStart' });
      const focusRules = ids();
      const strict = s.local.pomodoro.strictNow;
      await life.sendMessage({ action: 'pomodoroStop' });
      const afterRules = ids();
      return { idleRules, focusRules, afterRules, strict };
    },
    expect: (r) => {
      const ok = r.idleRules === '1,2000001' &&
        r.focusRules === '1,1500000,1500001' &&
        r.afterRules === '1,2000001' &&
        r.strict === true;
      return [ok, 'idle=[' + r.idleRules + '] focus=[' + r.focusRules + '] after=[' + r.afterRules + '] strictNow=' + r.strict];
    },
  },
  {
    name: 'P9 no task, a ticked-off task and a deleted task never break a session',
    run: async () => {
      NOW = T0;
      const s = seed({
        tasks: [{ id: 'done1', text: 'already done', done: true, createdAt: T0, doneAt: T0, pomodoros: 1, focusMs: 25 * MIN }],
        pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0, taskId: 'done1' },
      });
      const life = runLifetime(s);
      await life.settle();
      advance(26 * MIN);
      life.fireAlarm('tracking');
      await drain();
      const first = { focusToday: s.local.pomodoro.focusToday, pomos: s.local.todo.tasks[0].pomodoros };
      await life.sendMessage({ action: 'pomodoroStart', taskId: 'ghost' });
      advance(26 * MIN);
      life.fireAlarm('tracking');
      await drain();
      const second = { focusToday: s.local.pomodoro.focusToday, phase: s.local.pomodoro.phase };
      const errors = life.logs.filter((l) => l.indexOf('ERROR') === 0).length;
      return { first, second, errors };
    },
    expect: (r) => {
      const ok = r.first.focusToday === 1 && r.first.pomos === 2 &&
        r.second.focusToday === 2 && r.second.phase === 'shortBreak' && r.errors === 0;
      return [ok, 'doneTaskCredited=' + r.first.pomos + ' focusToday=' + r.second.focusToday +
        ' phase=' + r.second.phase + ' errors=' + r.errors];
    },
  },
  {
    name: 'P10 stale transitions do not notify, fresh ones do, both still credit',
    run: async () => {
      NOW = T0;
      const s1 = seed({ pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0 } });
      const l1 = runLifetime(s1);
      await l1.settle();
      l1.notifs.length = 0;
      advance(25 * MIN + 30 * 1000);
      l1.fireAlarm('pomodoroPhase');
      await drain();
      const fresh = l1.notifs.length;

      NOW = T0;
      const s2 = seed({ pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0 } });
      const l2 = runLifetime(s2);
      await l2.settle();
      l2.notifs.length = 0;
      advance(3 * 60 * MIN);
      l2.fireAlarm('pomodoroPhase');
      await drain();
      const stale = l2.notifs.length;
      return { fresh, stale, s2 };
    },
    expect: (r) => {
      const ok = r.fresh === 1 && r.stale === 0 && r.s2.local.pomodoro.focusToday === 1;
      return [ok, 'freshNotifs=' + r.fresh + ' staleNotifs=' + r.stale +
        ' staleStillCredited=' + r.s2.local.pomodoro.focusToday];
    },
  },
  {
    name: 'P11 startup re-arms the one-shot alarm from the stored deadline',
    run: async () => {
      NOW = T0;
      const endAt = T0 + 25 * MIN;
      const s = seed({ pomodoro: { phase: 'focus', endAt: endAt, startedAt: T0 } });
      const life = runLifetime(s);
      await life.settle();
      return { life, endAt };
    },
    expect: (r) => {
      const arms = r.life.alarmCalls.filter((a) => a.name === 'pomodoroPhase' && !a.clear);
      const last = arms[arms.length - 1];
      const ok = arms.length >= 1 && last && last.info && last.info.when === r.endAt;
      return [ok, 'arms=' + JSON.stringify(arms)];
    },
  },
  {
    name: 'P12 concurrent ticks (popup landing on the alarm) record the session once',
    run: async () => {
      NOW = T0;
      const s = seed({
        tasks: [{ id: 't1', text: 'Race', done: false, createdAt: T0, doneAt: 0, pomodoros: 0, focusMs: 0 }],
        pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0, taskId: 't1' },
      });
      const life = runLifetime(s);
      await life.settle();
      life.notifs.length = 0;
      advance(25 * MIN + 10 * 1000);
      // Two overlapping async transitions: the per-second popup tick landing
      // on top of the tracking alarm must not both record the session.
      await Promise.all([
        life.sendMessage({ action: 'pomodoroTick' }),
        life.sendMessage({ action: 'pomodoroTick' }),
      ]);
      return { s, life };
    },
    expect: (r) => {
      const p = r.s.local.pomodoro;
      const t = r.s.local.todo.tasks[0];
      const ok = p.focusToday === 1 && p.cycleDone === 1 && t.pomodoros === 1 && r.life.notifs.length === 1;
      return [ok, 'focusToday=' + p.focusToday + ' cycleDone=' + p.cycleDone +
        ' taskPomos=' + t.pomodoros + ' notifs=' + r.life.notifs.length];
    },
  },
  {
    name: 'P13 a missing chrome.notifications namespace must not kill the worker',
    run: async () => {
      NOW = T0;
      const s = seed({ pomodoro: { phase: 'focus', endAt: T0 + 25 * MIN, startedAt: T0 } });
      const life = runLifetime(s, { noNotifications: true });
      await life.settle();
      const started = await life.sendMessage({ action: 'pomodoroStart' });
      const st = await life.sendMessage({ action: 'pomodoroGetState' });
      return { started, st };
    },
    expect: (r) => {
      const ok = !!(r.started && r.started.success === true && r.st && r.st.success === true &&
        r.st.state.phase === 'focus' && r.st.notifications === false);
      return [ok, 'startOk=' + !!(r.started && r.started.success) +
        ' phase=' + (r.st && r.st.state && r.st.state.phase) +
        ' notifications=' + (r.st && r.st.notifications)];
    },
  },
  {
    name: 'P17 a foreign rule landing mid-write is absorbed, not reported',
    run: async () => {
      NOW = T0;
      const s = seed({
        rules: [
          { val: 'example.com', type: 'block', mode: 'website' },
          { val: 'example.org', type: 'block', mode: 'website' },
        ],
      });
      // Rule id 1 is dropped in just before the worker's first write, so the
      // write collides exactly the way it does when a reload races a dying
      // worker. The writer must re-read and retry instead of giving up.
      const life = runLifetime(s, { sneakRuleId: 1 });
      await life.settle();
      return { life };
    },
    expect: (r) => {
      const reported = r.life.logs.filter((l) => l.indexOf('syncAllRules error') !== -1).length;
      const ids = r.life.getRules().map((x) => x.id).sort();
      const ok = reported === 0 && ids.length === 2 && ids[0] === 1 && ids[1] === 2;
      return [ok, 'reported=' + reported + ' ruleIds=' + JSON.stringify(ids)];
    },
  },
  {
    name: 'P15 a burst of overlapping syncs never collides on a rule id',
    run: async () => {
      NOW = T0;
      const s = seed({
        rules: [
          { val: 'example.com', type: 'block', mode: 'website' },
          { val: 'example.org', type: 'block', mode: 'website' },
        ],
      });
      const life = runLifetime(s);
      await life.settle();
      // Alarms and tab events are fired without awaiting each other, so this
      // is exactly what the worker sees on a busy morning.
      const burst = [];
      for (let i = 0; i < 8; i++) burst.push(life.sendMessage({ action: 'syncRules' }));
      await Promise.all(burst);
      await drain();
      return { life };
    },
    expect: (r) => {
      const collisions = r.life.logs.filter((l) => l.indexOf('does not have a unique ID') !== -1).length;
      const ids = r.life.getRules().map((x) => x.id).sort();
      const ok = collisions === 0 && ids.length === 2 && ids[0] === 1 && ids[1] === 2;
      return [ok, 'collisions=' + collisions + ' ruleIds=' + JSON.stringify(ids)];
    },
  },
  {
    name: 'P16 a sync burst cannot leave a stale rule set behind',
    run: async () => {
      NOW = T0;
      const s = seed({
        rules: [{ val: 'example.com', type: 'timed', mode: 'website', limitMin: 30 }],
      });
      const life = runLifetime(s);
      await life.settle();
      await life.sendMessage({ action: 'pomodoroStart' });
      const during = [];
      for (let i = 0; i < 6; i++) during.push(life.sendMessage({ action: 'syncRules' }));
      await Promise.all(during);
      await drain();
      const duringFocus = life.getRules().map((x) => x.id).sort();
      await life.sendMessage({ action: 'pomodoroStop' });
      const after = [];
      for (let i = 0; i < 6; i++) after.push(life.sendMessage({ action: 'syncRules' }));
      await Promise.all(after);
      await drain();
      const afterStop = life.getRules().map((x) => x.id).sort();
      return { life, duringFocus, afterStop };
    },
    expect: (r) => {
      const collisions = r.life.logs.filter((l) => l.indexOf('does not have a unique ID') !== -1).length;
      const ok = collisions === 0 &&
        r.duringFocus.length === 1 && r.duringFocus[0] === 1500000 &&
        r.afterStop.length === 0;
      return [ok, 'collisions=' + collisions + ' duringFocus=' + JSON.stringify(r.duringFocus) +
        ' afterStop=' + JSON.stringify(r.afterStop)];
    },
  },
  {
    name: 'P14 manifest exposes blockpage.html so redirects to it are allowed',
    run: async () => {
      const manifestPath = path.join(path.dirname(SRC), 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return { manifest };
    },
    expect: (r) => {
      const war = r.manifest.web_accessible_resources || [];
      const exposed = war.some((e) => (e.resources || []).indexOf('blockpage.html') !== -1);
      // Chrome refuses a DNR redirect - and a page-level navigation - to an
      // extension page that is not web accessible (ERR_BLOCKED_BY_CLIENT).
      // Blocking is dead without this manifest entry; verified in real Chrome.
      return [exposed, 'web_accessible_resources=' + JSON.stringify(war)];
    },
  },
];

(async () => {
  for (const sc of scenarios) {
    let r;
    try {
      r = await sc.run();
    } catch (err) {
      check(sc.name, false, 'threw: ' + err.message);
      continue;
    }
    let pass, detail;
    try {
      const out = sc.expect(r);
      pass = out[0];
      detail = out[1];
    } catch (err) {
      pass = false;
      detail = 'expect threw: ' + err.message;
    }
    check(sc.name, pass, detail);
  }

  console.log('\n=== ' + LABEL + ' ===');
  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + '\n         ' + r.detail);
  }
  console.log('  -> ' + (results.length - failed) + '/' + results.length + ' passed');
})();
