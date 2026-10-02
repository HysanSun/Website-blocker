// ============================================================
// Harness: drives background.js through simulated MV3 service-worker
// lifetimes and reports whether the streak survived each scenario.
//
// Usage: node harness.js <path-to-background.js> [label]
// ============================================================
const fs = require('fs');
const vm = require('vm');

const SRC = process.argv[2];
const LABEL = process.argv[3] || SRC;
const code = fs.readFileSync(SRC, 'utf8');

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const T0 = Date.now();

// --- chrome.storage areas -------------------------------------------------
// local   : survives everything except uninstall
// session : survives SW suspension + system sleep; wiped by disable/reload/restart
// sync    : survives everything
function makeStores() {
  return { local: {}, session: {}, sync: {} };
}

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

// --- one service-worker lifetime -----------------------------------------
function runLifetime(stores, opts) {
  const hostAccess = (opts && 'hostAccess' in opts) ? opts.hostAccess : true;
  const logs = [];
  const timers = [];
  const L = { startup: [], installed: [], alarm: [], message: [], activated: [], updated: [] };

  const chrome = {
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    alarms: {
      create: () => {},
      clear: async () => {},
      onAlarm: { addListener: (fn) => L.alarm.push(fn) },
    },
    storage: {
      local: area(stores.local),
      session: area(stores.session),
      sync: area(stores.sync),
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {},
    },
    tabs: {
      query: async () => [],
      update: async () => {},
      onActivated: { addListener: (fn) => L.activated.push(fn) },
      onUpdated: { addListener: (fn) => L.updated.push(fn) },
    },
    runtime: {
      getURL: (path) => 'chrome-extension://test/' + path,
      onMessage: { addListener: (fn) => L.message.push(fn) },
      onStartup: { addListener: (fn) => L.startup.push(fn) },
      onInstalled: { addListener: (fn) => L.installed.push(fn) },
    },
    notifications: {
      create: () => {},
      clear: async () => {},
      onClicked: { addListener: () => {} },
    },
    // Host ("site access") permission as the user currently has it set.
    permissions: {
      contains: (_q, cb) => { if (cb) cb(hostAccess); return Promise.resolve(hostAccess); },
    },
  };

  const sandbox = {
    chrome,
    console: {
      log: (...a) => logs.push(a.join(' ')),
      debug: () => {},
      warn: (...a) => logs.push('WARN ' + a.join(' ')),
      error: (...a) => logs.push('ERROR ' + a.join(' ')),
    },
    // The grace delay is the only timer the worker uses; queue it so events
    // can be dispatched before it fires, exactly as Chrome does.
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    Date, Promise, JSON, Math, Object, Array, String, Number, Boolean,
    Error, RegExp, isNaN, parseInt, parseFloat, Set, Map,
    // A vm context only gets ECMAScript intrinsics, so the host objects the
    // worker relies on have to be handed in. The tracker parses the active
    // tab's host with URL.
    URL,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);

  // Drain microtasks, then run queued timers, repeatedly until quiet.
  async function settle() {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setImmediate(r));
      if (timers.length === 0) {
        await new Promise((r) => setImmediate(r));
        if (timers.length === 0) return;
      }
      timers.shift()();
    }
  }

  return {
    logs,
    settle,
    fireStartup: () => L.startup.forEach((fn) => fn()),
    fireInstalled: (reason) => L.installed.forEach((fn) => fn({ reason })),
  };
}

// --- scenario plumbing ----------------------------------------------------
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}

// A live extension: a streak that is `ageDays` old, last heartbeat `hbAgeMs`
// ago, and a session marker present (worker was suspended, not shut down).
function seed({ ageDays = 3, hbAgeMs = 30 * 1000, alive = true, hadHostAccess = true } = {}) {
  const stores = makeStores();
  stores.local.startDate = T0 - ageDays * DAY;
  stores.local.lastHeartbeat = T0 - hbAgeMs;
  if (hadHostAccess) stores.local.hadHostAccess = true;
  if (alive) stores.session.swAlive = T0 - hbAgeMs;
  return stores;
}

const scenarios = [
  {
    // The common case: Chrome tore the worker down and an alarm revived it.
    name: 'S1 alarm revival, recent heartbeat',
    run: async () => {
      const s = seed({ hbAgeMs: 30 * 1000 });
      const before = s.local.startDate;
      const life = runLifetime(s);
      await life.settle();
      return { s, before };
    },
    expect: (r) => [!r.s.local.needsAlert && r.s.local.startDate === r.before, `startDate=${r.s.local.startDate - r.before}ms needsAlert=${!!r.s.local.needsAlert}`],
  },
  {
    // Regression proof: sleep or a long suspension leaves a big heartbeat gap.
    // The old 61s threshold reset the streak here; nothing else changed.
    name: 'S2 long suspension / sleep, recent heartbeat stale',
    run: async () => {
      const s = seed({ hbAgeMs: 45 * MIN });
      const before = s.local.startDate;
      const life = runLifetime(s);
      await life.settle();
      return { s, before };
    },
    expect: (r) => [!r.s.local.needsAlert && r.s.local.startDate === r.before, `startDate=${r.s.local.startDate - r.before}ms needsAlert=${!!r.s.local.needsAlert}`],
  },
  {
    // Browser relaunch: in-memory session storage is gone, onStartup fires.
    name: 'S3 browser restart (onStartup, session wiped)',
    run: async () => {
      const s = seed({ alive: false, hbAgeMs: 8 * 60 * MIN });
      const before = s.local.startDate;
      const life = runLifetime(s);
      life.fireStartup();
      await life.settle();
      return { s, before };
    },
    expect: (r) => [!r.s.local.needsAlert && r.s.local.startDate === r.before, `startDate=${r.s.local.startDate - r.before}ms needsAlert=${!!r.s.local.needsAlert}`],
  },
  {
    // Dev reload / version update: session wiped, onInstalled:update fires.
    name: 'S4 extension reload / update (onInstalled:update)',
    run: async () => {
      const s = seed({ alive: false, hbAgeMs: 20 * 1000 });
      const before = s.local.startDate;
      const life = runLifetime(s);
      life.fireInstalled('update');
      await life.settle();
      return { s, before };
    },
    expect: (r) => [!r.s.local.needsAlert && r.s.local.startDate === r.before, `startDate=${r.s.local.startDate - r.before}ms needsAlert=${!!r.s.local.needsAlert}`],
  },
  {
    // The tamper case the user DOES want punished: switched off, then back on.
    // Chrome fires no lifecycle event for this, and session storage is wiped.
    name: 'S5 disable -> enable  (MUST reset)',
    run: async () => {
      const s = seed({ alive: false, hbAgeMs: 30 * MIN });
      const before = s.local.startDate;
      const life = runLifetime(s);
      await life.settle();
      return { s, before };
    },
    expect: (r) => [r.s.local.needsAlert === true && r.s.local.startDate > r.before + DAY, `startDate=${r.s.local.startDate - r.before}ms needsAlert=${!!r.s.local.needsAlert}`],
  },
  {
    // First install: nothing to break, so no bogus strike alert.
    name: 'S6 first install (no startDate yet)',
    run: async () => {
      const s = makeStores();
      const life = runLifetime(s);
      life.fireInstalled('install');
      await life.settle();
      return { s, before: undefined };
    },
    expect: (r) => [!!r.s.local.startDate && !r.s.local.needsAlert, `startDate set=${!!r.s.local.startDate} needsAlert=${!!r.s.local.needsAlert}`],
  },
  {
    // Brand-new profile where only an alarm woke the worker: still no alert.
    name: 'S7 first run, no lifecycle event',
    run: async () => {
      const s = makeStores();
      const life = runLifetime(s);
      await life.settle();
      return { s, before: undefined };
    },
    expect: (r) => [!!r.s.local.startDate && !r.s.local.needsAlert, `startDate set=${!!r.s.local.startDate} needsAlert=${!!r.s.local.needsAlert}`],
  },
  {
    // Site access taken away from a working setup: the blocker stops
    // enforcing, so the streak must go. (MUST reset)
    name: 'S8 site access revoked  (MUST reset)',
    run: async () => {
      const s = seed({ alive: true, hadHostAccess: true });
      const before = s.local.startDate;
      const life = runLifetime(s, { hostAccess: false });
      await life.settle();
      return { s, before };
    },
    expect: (r) => [r.s.local.needsAlert === true && r.s.local.startDate > r.before + DAY, `startDate=${r.s.local.startDate - r.before}ms needsAlert=${!!r.s.local.needsAlert}`],
  },
  {
    // Fresh install where Chrome left <all_urls> on "when you click": access
    // was never held, so this is NOT tampering and must not raise a strike.
    name: 'S9 fresh install, default "on click" access',
    run: async () => {
      const s = makeStores();
      const life = runLifetime(s, { hostAccess: false });
      life.fireInstalled('install');
      await life.settle();
      return { s, before: undefined };
    },
    expect: (r) => [!!r.s.local.startDate && !r.s.local.needsAlert, `startDate set=${!!r.s.local.startDate} needsAlert=${!!r.s.local.needsAlert}`],
  },
  {
    // Steady state, access still granted: nothing may disturb the streak.
    name: 'S10 steady state, access granted',
    run: async () => {
      const s = seed();
      const before = s.local.startDate;
      const life = runLifetime(s, { hostAccess: true });
      await life.settle();
      return { s, before };
    },
    expect: (r) => [!r.s.local.needsAlert && r.s.local.startDate === r.before, `startDate=${r.s.local.startDate - r.before}ms needsAlert=${!!r.s.local.needsAlert}`],
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
    const [pass, detail] = sc.expect(r);
    check(sc.name, pass, detail);
  }

  console.log('\n=== ' + LABEL + ' ===');
  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + '\n         ' + r.detail);
  }
  console.log(`  -> ${results.length - failed}/${results.length} passed`);
})();
