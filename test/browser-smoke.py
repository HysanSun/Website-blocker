#!/usr/bin/env python
"""Real-browser smoke test for the Website Blocker extension.

The vm-based harnesses (test/*-harness.js) never load a real extension, so they
cannot catch "the service worker died before it registered anything" bugs. The
bug that motivated this script: background.js touched chrome.notifications at
top level, and chrome.notifications is undefined until the permission has
actually been granted (reloading an unpacked extension does NOT grant it).
That one throw silently killed the message handler, the alarm handlers,
initialize(), the tabs listeners and the whole pomodoro feature.

It also covers the DNR redirect end to end. Chrome refuses to redirect to an
extension page that is not listed in web_accessible_resources, which breaks
site blocking completely (ERR_BLOCKED_BY_CLIENT).

Setup:
    pip install playwright
    playwright install chromium

Run:
    python test/browser-smoke.py [path-to-extension]   # default: repo root

Extensions need a headed browser, so this opens a real Chromium window.
"""
import http.server
import os
import sys
import threading
import time

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("playwright is not installed: pip install playwright && playwright install chromium")

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, os.pardir))
PROFILE = os.path.join(os.environ.get("TEMP", "/tmp"), "blocker-smoke-%d" % time.time())

results = []

MARKER = b"<html><body>marker page</body></html>"


class MarkerServer(http.server.BaseHTTPRequestHandler):
    """Answers every request with a page the checks can recognise."""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(MARKER)))
        self.end_headers()
        self.wfile.write(MARKER)

    def log_message(self, *args):
        pass


# The hosts the extent checks use. The browser resolves them to the marker
# server instead of the network, so "this host is still reachable" can be
# asserted by finding the marker - "it did not land on blockpage.html" would
# also pass on a DNS failure. `*.invalid` can never resolve for real.
MARKER_HOSTS = [
    "testsite.invalid", "www.testsite.invalid", "mail.testsite.invalid",
    "pan.testsite.invalid", "a.pan.testsite.invalid", "nottestsite.invalid",
    "testsite.invalid.evil.invalid",
]


def check(name, ok, detail=""):
    results.append(ok)
    print("  %s %s %s" % ("PASS" if ok else "FAIL", name, detail))


def main():
    print("extension:", EXT)
    marker = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MarkerServer)
    port = marker.server_address[1]
    threading.Thread(target=marker.serve_forever, daemon=True).start()
    resolver = ",".join("MAP %s 127.0.0.1:%d" % (h, port) for h in MARKER_HOSTS)
    print("marker server: 127.0.0.1:%d" % port)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,  # extensions are unsupported in the headless shell
            args=["--disable-extensions-except=" + EXT, "--load-extension=" + EXT,
                  "--host-resolver-rules=" + resolver],
        )
        try:
            sw = None
            for _ in range(80):
                if ctx.service_workers:
                    sw = ctx.service_workers[0]
                    break
                time.sleep(0.25)
            if not sw:
                check("service worker started", False, "extension failed to load")
                return
            ext_id = sw.url.split("/")[2]
            time.sleep(2)
            print("extension id:", ext_id)
            check("service worker started", True)

            # The worker console is where regressions like the DNR rule-id
            # collision show up, and the manifest version is how you tell
            # whether a chrome://extensions reload actually picked up the code.
            sw_errors = []
            sw.on("console", lambda m: sw_errors.append(m.text) if m.type == "error" else None)
            print("running version:", sw.evaluate("() => chrome.runtime.getManifest().version"))

            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: (errors.append(str(e)), print("  [page error] %s" % e)))
            page.goto("chrome-extension://%s/pomodoro.html" % ext_id)
            page.wait_for_timeout(1200)

            # 1. The worker answers at all. A top-level throw makes this time out.
            raw = page.evaluate("""() => new Promise(res => {
                chrome.runtime.sendMessage({action:'pomodoroGetState'}, r => {
                    res(JSON.stringify({resp: r,
                        err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null}));
                });
                setTimeout(() => res('TIMEOUT'), 4000);
            })""")
            check("pomodoroGetState responds", raw != "TIMEOUT" and '"success":true' in raw.replace(" ", ""), raw[:120])

            # 2. The clock actually runs.
            before = page.eval_on_selector("#clock", "e=>e.textContent")
            page.click("#primary-btn")
            page.wait_for_timeout(3000)
            after = page.eval_on_selector("#clock", "e=>e.textContent")
            check("clock counts down after Start", before != after, "%s -> %s" % (before, after))

            # 3. Tasks can be added and reach storage.
            page.fill("#task-input", "smoke task")
            page.click("#task-add")
            page.wait_for_timeout(1200)
            listed = page.eval_on_selector("#task-list", "e=>e.textContent")
            stored = sw.evaluate("async () => JSON.stringify(await chrome.storage.local.get(['todo']))")
            check("task add reaches the list and storage",
                  "smoke task" in listed and "smoke task" in stored, listed)

            page.click("#stop-btn")
            page.wait_for_timeout(800)

            # 3b. Planning a run: the play button on a task asks how many units
            # to spend, "All" fills what is left of the estimate, and starting it
            # puts the worker in a multi-unit run that cannot be skipped.
            page.click("#task-list .task .play")
            page.wait_for_selector("#plan-modal:not([hidden])", timeout=5000)
            check("the play button opens the plan dialog",
                  page.eval_on_selector("#plan-title", "e=>e.textContent") == "smoke task")
            # Clearing a number field to retype must not snap back and eat the
            # next keystroke - that is how typing "3" used to become "13".
            page.fill("#plan-estimate", "")
            page.type("#plan-estimate", "3")
            page.wait_for_timeout(150)
            typed = page.eval_on_selector("#plan-estimate", "e=>e.value")
            check("typing an estimate is not mangled by the live clamp",
                  typed == "3", "value=" + typed)
            page.click("#plan-all")
            units = page.eval_on_selector("#plan-units", "e=>e.value")
            check("All fills the units left in the estimate", units == "3", "units=" + units)
            page.click("#plan-start")
            page.wait_for_timeout(1200)
            run = sw.evaluate("async () => JSON.stringify((await chrome.storage.local.get(['pomodoro'])).pomodoro.run)")
            check("starting a planned run records the run on the worker",
                  '"units":3' in run.replace(" ", ""), run[:120])
            stored_todo = sw.evaluate("async () => JSON.stringify((await chrome.storage.local.get(['todo'])).todo.tasks)")
            check("the estimate is saved on the task",
                  '"plannedUnits":3' in stored_todo.replace(" ", ""), stored_todo[:160])
            check("a focus session cannot be skipped",
                  page.eval_on_selector("#skip-btn", "e=>e.disabled") is True)
            page.click("#stop-btn")
            page.wait_for_timeout(800)

            # 3c. Printing the list: the button builds a plain sheet, and the
            # print rules reduce the page to that sheet. window.print itself is
            # stubbed - the real dialog would block the headed browser.
            check("the Tasks card offers a print button",
                  page.eval_on_selector_all("#print-tasks", "els=>els.length") == 1)
            page.evaluate("""() => {
                window.__prints = 0;
                window.__classAtPrint = false;
                window.print = () => {
                    window.__prints++;
                    window.__classAtPrint = document.body.classList.contains('printing');
                };
            }""")
            page.click("#print-tasks")
            page.wait_for_timeout(300)
            prints = page.evaluate("() => [window.__prints, window.__classAtPrint]")
            sheet = page.eval_on_selector("#print-sheet", "e=>e.textContent")
            check("printing builds a sheet out of the list",
                  prints == [1, True] and "smoke task" in sheet and "0/3" in sheet,
                  "prints=%s sheet=%s" % (prints, sheet[:110]))
            check("the app is back after printing",
                  page.eval_on_selector("body", "e=>e.classList.contains('printing')") is False)
            page.evaluate("() => document.body.classList.add('printing')")
            page.emulate_media(media="print")
            page.wait_for_timeout(200)
            media = page.evaluate("""() => ({
                sheet: getComputedStyle(document.getElementById('print-sheet')).display,
                app: getComputedStyle(document.querySelector('.container')).display})""")
            page.emulate_media(media="screen")
            page.evaluate("() => document.body.classList.remove('printing')")
            check("print media shows only the sheet",
                  media["sheet"] != "none" and media["app"] == "none", str(media))

            # 3d. Planning is its own action: the unit counter opens the planner
            # and Save plan writes the estimate without starting anything.
            page.click("#task-list .task .meta")
            page.wait_for_selector("#plan-modal:not([hidden])", timeout=5000)
            check("the unit counter opens the planner",
                  page.eval_on_selector("#plan-modal",
                                        "e=>e.classList.contains('no-start')") is False)
            page.fill("#plan-estimate", "5")
            page.click("#plan-save")
            page.wait_for_timeout(600)
            planned = sw.evaluate("""async () => {
                const t = (await chrome.storage.local.get(['todo'])).todo.tasks[0];
                const p = (await chrome.storage.local.get(['pomodoro'])).pomodoro;
                return JSON.stringify({planned: t.plannedUnits, phase: p.phase, taskId: p.taskId});
            }""")
            check("Save plan stores the estimate and starts nothing",
                  '"planned":5' in planned.replace(" ", "")
                  and '"phase":"idle"' in planned.replace(" ", ""), planned)
            toast = page.eval_on_selector_all(".wb-toast", "els=>els.map(e=>e.textContent).join(' | ')")
            check("saving a plan says so", "Plan saved" in toast, toast)

            # ...and while a run is live it stays a planner: the start controls
            # are gone, the estimate is still editable, and the timer is not
            # touched. One run at a time is the whole point.
            page.click("#task-list .task .play")
            page.wait_for_selector("#plan-modal:not([hidden])", timeout=5000)
            page.click("#plan-start")
            page.wait_for_timeout(900)
            page.click("#task-list .task .meta")
            page.wait_for_selector("#plan-modal:not([hidden])", timeout=5000)
            hidden_start = page.eval_on_selector("#plan-start", "e=>getComputedStyle(e).display")
            hidden_units = page.eval_on_selector("#plan-units", "e=>getComputedStyle(e).display")
            check("the planner hides the start controls during a run",
                  hidden_start == "none" and hidden_units == "none",
                  "start=%s units=%s" % (hidden_start, hidden_units))
            page.fill("#plan-estimate", "4")
            page.click("#plan-save")
            page.wait_for_timeout(600)
            mid = sw.evaluate("""async () => {
                const t = (await chrome.storage.local.get(['todo'])).todo.tasks[0];
                const p = (await chrome.storage.local.get(['pomodoro'])).pomodoro;
                return JSON.stringify({planned: t.plannedUnits, phase: p.phase, live: p.endAt > 0});
            }""")
            check("a plan can be changed mid-run without touching the timer",
                  '"planned":4' in mid.replace(" ", "") and '"phase":"focus"' in mid.replace(" ", "")
                  and '"live":true' in mid.replace(" ", ""), mid)
            # The play button still means "start", and it says why it cannot.
            page.click("#task-list .task .play")
            page.wait_for_timeout(400)
            toast = page.eval_on_selector_all(".wb-toast", "els=>els.map(e=>e.textContent).join(' | ')")
            check("the play button refuses a second run out loud",
                  page.eval_on_selector("#plan-modal", "e=>e.hidden") is True
                  and "already going" in toast, toast)
            page.click("#stop-btn")
            page.wait_for_timeout(800)

            # 4. Blocking: a DNR redirect must land on blockpage.html.
            #
            # The rule goes in whatever the network is doing - only the redirect
            # assertion needs example.com to be reachable. Nesting the saveRules
            # inside that branch made every later rule check depend on the
            # internet: when example.com was unreachable, nothing was ever
            # blocked and the burst check below failed on an empty rule set.
            probe = ctx.new_page()
            online = True
            try:
                probe.goto("https://example.com", wait_until="domcontentloaded", timeout=15000)
            except Exception:
                online = False
            page.evaluate("""() => new Promise(res => chrome.runtime.sendMessage(
                {action:'saveRules',
                 rules:[{val:'example.com', type:'block', mode:'website'}]}, res))""")
            page.wait_for_timeout(1500)
            if not online:
                print("  SKIP  DNR redirect check (example.com is unreachable)")
            else:
                try:
                    probe.goto("https://example.com", wait_until="domcontentloaded", timeout=15000)
                except Exception:
                    pass
                probe.wait_for_timeout(1200)
                landed = "blockpage.html" in probe.url
                check("blocked site redirects to blockpage.html", landed, probe.url)
                if landed:
                    check("block page shows the pomodoro entry",
                          "focus session" in probe.eval_on_selector("#pomodoro-line", "e=>e.textContent").lower())
                    # The redirect carries the rule that fired, so the page can
                    # offer the one thing the user wants: a timed way back in.
                    check("the redirect names the rule that fired",
                          "host=example.com" in probe.url, probe.url)
                    probe.wait_for_timeout(600)
                    check("the blocked page offers a timed unlock",
                          probe.eval_on_selector("#unlock-row", "e=>e.hidden") is False
                          and "Unlock" in probe.eval_on_selector("#unlock-btn", "e=>e.textContent"))

            # 5. The stopwatch button is the only way into the timer from the
            # blocked page, so a dead button makes the feature look broken no
            # matter how healthy the worker is. Close the timer first so the
            # click has to create the window rather than focus an existing one.
            page.close()
            entry = ctx.new_page()
            entry.goto("chrome-extension://%s/blockpage.html" % ext_id)
            entry.wait_for_timeout(800)
            check("blocked page still has the stopwatch button",
                  entry.eval_on_selector_all("#pomodoro-btn", "els=>els.length") == 1)
            entry.click("#pomodoro-btn")
            entry.wait_for_timeout(2500)
            opened = sw.evaluate("""() => new Promise(res => chrome.windows.getAll({populate: true}, wins => res(
                (wins || []).some(w => (w.tabs || []).some(t => (t.url || '').indexOf('pomodoro.html') !== -1)))))""")
            check("the stopwatch button opens the timer window", bool(opened))

            # 6. A burst of overlapping syncs is the shape that used to collide
            # on rule id 1 and empty the rule set.
            entry.evaluate("""() => Promise.all(new Array(8).fill(0).map(() => new Promise(
                res => chrome.runtime.sendMessage({action: 'syncRules'}, res))))""")
            entry.wait_for_timeout(1500)
            rules = sw.evaluate("async () => JSON.stringify(await chrome.declarativeNetRequest.getDynamicRules())")
            items_now = sw.evaluate("async () => JSON.stringify((await chrome.storage.sync.get(['blockedItems'])).blockedItems)")
            check("a burst of rule syncs leaves exactly one rule per blocked site",
                  rules.count('"id":1') == 1 and "example.com" in rules,
                  rules[:140] + " | items=" + str(items_now)[:80])

            # 6b. Tier 2: a rule with a time window is only installed while its
            # window is open, and the settings page has to be able to write one.
            st = ctx.new_page()
            st.on("pageerror", lambda e: (errors.append(str(e)), print("  [page error] %s" % e)))
            st.goto("chrome-extension://%s/settings.html" % ext_id)
            st.wait_for_timeout(900)
            check("settings page exposes the window control",
                  st.eval_on_selector_all("#window-toggle", "els=>els.length") == 1)
            st.click("#window-toggle")
            st.wait_for_timeout(200)
            check("the window control opens its day and hour pickers",
                  st.eval_on_selector("#window-group", "e=>e.hidden") is False)
            # A window that is closed right now: 00:00-00:01 today. The rule may
            # exist in storage, but no DNR rule may be derived from it.
            st.evaluate("""() => new Promise(res => chrome.runtime.sendMessage({action:'saveRules',
                rules:[{val:'example.com', type:'block', mode:'website'},
                       {val:'windowed.invalid', type:'block', mode:'website',
                        window:{days:[], from:'00:00', to:'00:01'}}]}, res))""")
            st.wait_for_timeout(1200)
            rules_w = sw.evaluate("async () => JSON.stringify(await chrome.declarativeNetRequest.getDynamicRules())")
            stored_w = sw.evaluate("async () => JSON.stringify((await chrome.storage.sync.get(['blockedItems'])).blockedItems)")
            check("a rule outside its window is stored but not enforced",
                  "windowed.invalid" in stored_w and "windowed.invalid" not in rules_w,
                  rules_w[:160])
            # ...and the form round-trips a window back into the rule list. The
            # rules were written straight to the worker, so the page has to be
            # reloaded to see them (it only re-reads on its own every 30s).
            st.reload()
            st.wait_for_timeout(1000)
            check("the rule list says when a windowed rule applies",
                  "During" in st.eval_on_selector("#rules-list", "e=>e.textContent")
                  or "Outside its hours" in st.eval_on_selector("#rules-list", "e=>e.textContent"))
            check("the settings page offers a per-rule unlock",
                  st.eval_on_selector_all(".rule-unlock-btn", "els=>els.length") >= 2)
            # ...and clicking it has to actually grant the host. "The button is
            # there" was the whole check, which is how a worker that had never
            # heard of tempUnlock still looked like a working feature.
            st.click(".rule-unlock-btn")
            st.wait_for_timeout(1200)
            unlocked = sw.evaluate("async () => JSON.stringify(await chrome.storage.local.get(['tempUnlocks']))")
            toast = st.eval_on_selector_all(".wb-toast", "els=>els.map(e=>e.textContent).join(' | ')")
            check("clicking Unlock grants a timed allow rule",
                  "example.com" in unlocked and "Unlocked for" in toast,
                  "unlocks=%s toast=%s" % (unlocked[:90], toast))
            # The stale-worker contract: a worker that does not know an action
            # names it, so the page can tell "reload the extension" apart from
            # "this feature is broken".
            unknown = st.evaluate("""() => new Promise(res => chrome.runtime.sendMessage(
                {action:'noSuchAction'}, r => res(JSON.stringify(r))))""")
            check("an unknown action names itself back",
                  "noSuchAction" in unknown.replace(" ", ""), unknown[:120])
            st.close()

            # 7. The review question and the skip rule. Waiting out a real
            # 25 + 5 minute run is not a smoke test, so seed the worker state
            # that a finished run would have left behind and drive the UI.
            page2 = ctx.new_page()
            page2.on("pageerror", lambda e: (errors.append(str(e)), print("  [page error] %s" % e)))
            page2.goto("chrome-extension://%s/pomodoro.html" % ext_id)
            page2.wait_for_timeout(600)
            task_id = page2.evaluate("""async () => {
                const t = (await chrome.storage.local.get(['todo'])).todo.tasks.find(x => x.text === 'smoke task');
                return t ? t.id : null;
            }""")
            check("the smoke task survives for the review check", bool(task_id))
            seed_review = """(id) => new Promise(res => chrome.storage.local.set({pomodoro: {
                v: 1, phase: 'idle', endAt: 0, startedAt: 0, pausedRemainingMs: null, cycleDone: 0,
                dayKey: '', focusToday: 2, focusMsToday: 0, taskId: id, strictNow: false,
                run: null, review: {taskId: id, at: Date.now()}
            }}, res))"""
            page2.evaluate(seed_review, task_id)
            page2.reload()
            page2.wait_for_timeout(900)
            check("the review card asks about the task",
                  page2.eval_on_selector("#review-card", "e=>e.hidden") is False)
            check("the review card names the task",
                  "smoke task" in page2.eval_on_selector("#review-text", "e=>e.textContent"))

            # "Not yet" clears the question and re-opens the plan dialog.
            page2.click("#review-continue")
            page2.wait_for_timeout(900)
            check("answering 'Not yet' reopens the plan dialog",
                  page2.eval_on_selector("#plan-modal", "e=>e.hidden") is False)
            page2.click("#plan-cancel")
            page2.wait_for_timeout(300)

            # "Yes, it's done" archives the task.
            page2.evaluate(seed_review, task_id)
            page2.reload()
            page2.wait_for_timeout(900)
            page2.click("#review-done")
            page2.wait_for_timeout(900)
            archived = sw.evaluate("""async () => (await chrome.storage.local.get(['todo'])).todo.tasks[0].done === true""")
            check("answering 'done' archives the task", archived)
            check("the archived task shows up under Done",
                  "smoke task" in page2.eval_on_selector("#done-list", "e=>e.textContent"))

            # A focus session refuses to be skipped; a break does not. Start it
            # through the button so the page and the worker agree on the state -
            # a raw message would leave the page rendering its stale snapshot.
            page2.click("#primary-btn")
            page2.wait_for_timeout(900)
            started = sw.evaluate("async () => (await chrome.storage.local.get(['pomodoro'])).pomodoro.phase")
            check("the start button puts the worker in focus", started == "focus", "phase=" + str(started))
            skipped = page2.evaluate("""() => new Promise(res => chrome.runtime.sendMessage(
                {action:'pomodoroSkip'}, r => res(r && r.state ? r.state.phase : null)))""")
            check("the worker refuses to skip a focus session", skipped == "focus", "phase=" + str(skipped))
            check("the skip button is disabled while focusing",
                  page2.eval_on_selector("#skip-btn", "e=>e.disabled") is True)

            # The one pause a focus session gets: the clock freezes, it expires
            # on its own, and the button is spent for the rest of the session.
            page2.click("#primary-btn")
            page2.wait_for_timeout(900)
            st = page2.evaluate("""() => new Promise(res => chrome.runtime.sendMessage(
                {action:'pomodoroGetState'}, r => res({paused: r.state.pausedRemainingMs,
                    used: r.state.pauseUsed, leftMs: r.state.pauseEndsAt - Date.now(),
                    maxMs: r.pauseMaxMs})))""")
            check("pausing a focus freezes the clock and caps the pause",
                  0 < st["leftMs"] <= st["maxMs"] and st["used"] is True, str(st))
            check("the pause note counts the pause down",
                  "restarts itself in" in page2.eval_on_selector("#focus-note", "e=>e.textContent"),
                  page2.eval_on_selector("#focus-note", "e=>e.textContent"))
            check("the button offers Resume while paused",
                  page2.eval_on_selector("#primary-btn", "e=>e.textContent").strip() == "Resume")
            page2.click("#primary-btn")
            page2.wait_for_timeout(900)
            after_resume = page2.evaluate("""() => new Promise(res => chrome.runtime.sendMessage(
                {action:'pomodoroGetState'}, r => res({paused: r.state.pausedRemainingMs,
                    used: r.state.pauseUsed})))""")
            check("resuming clears the freeze but keeps the pause spent",
                  after_resume["paused"] is None and after_resume["used"] is True, str(after_resume))
            check("the pause button is greyed out for the rest of the session",
                  page2.eval_on_selector("#primary-btn", "e=>e.disabled") is True)
            check("the greyed-out button explains why",
                  "already used" in page2.eval_on_selector("#primary-btn", "e=>e.title"))
            # The cursor is still on the button after the click, which is exactly
            # when a hover rule would hide the disabled state.
            page2.hover("#primary-btn")
            page2.wait_for_timeout(200)
            spent_opacity = page2.evaluate(
                "() => parseFloat(getComputedStyle(document.getElementById('primary-btn')).opacity)")
            check("the greyed-out button looks it, even under the cursor",
                  spent_opacity < 0.5, "opacity=%s" % spent_opacity)
            # ... and the worker refuses a pause sent anyway.
            second = page2.evaluate("""() => new Promise(res => chrome.runtime.sendMessage(
                {action:'pomodoroPause'}, r => res(r.state.pausedRemainingMs)))""")
            check("a second pause on the same focus is refused", second is None, str(second))

            page2.evaluate("() => new Promise(res => chrome.runtime.sendMessage({action:'pomodoroStop'}, res))")
            page2.wait_for_timeout(400)
            page2.evaluate("""() => new Promise(res => chrome.storage.local.set({pomodoro: {
                v: 1, phase: 'shortBreak', endAt: Date.now() + 60000, startedAt: Date.now(),
                pausedRemainingMs: null, cycleDone: 1, dayKey: '', focusToday: 1, focusMsToday: 0,
                taskId: null, strictNow: false, run: null, review: null
            }}, res))""")
            page2.reload()
            page2.wait_for_timeout(900)
            check("the skip button is live on a break",
                  page2.eval_on_selector("#skip-btn", "e=>e.disabled") is False)
            page2.click("#skip-btn")
            page2.wait_for_timeout(900)
            after_skip = sw.evaluate("async () => (await chrome.storage.local.get(['pomodoro'])).pomodoro.phase")
            check("skipping a break moves the worker on without crediting it",
                  after_skip in ("idle", "focus"), "phase=" + str(after_skip))
            page2.evaluate("() => new Promise(res => chrome.runtime.sendMessage({action:'pomodoroStop'}, res))")

            # 8. The manual is part of the page and has to open.
            check("the manual starts collapsed",
                  page2.eval_on_selector("#manual-panel", "e=>e.hidden") is True)
            page2.click("#manual-toggle")
            page2.wait_for_timeout(300)
            manual = page2.eval_on_selector("#manual-panel", "e=>e.textContent")
            check("the manual opens and explains the timer",
                  page2.eval_on_selector("#manual-panel", "e=>e.hidden") is False
                  and "Timer settings" in manual and "Skip" in manual,
                  "%d chars" % len(manual))

            # 8b. The trend card: collapsed until asked for, seven days wide, and
            # it has to answer at all (the page is the only consumer of getStats).
            check("the trend starts collapsed",
                  page2.eval_on_selector("#trend-panel", "e=>e.hidden") is True)
            page2.click("#trend-toggle")
            page2.wait_for_timeout(400)
            cols = page2.eval_on_selector_all("#trend-bars .trend-col", "els=>els.length")
            total = page2.eval_on_selector("#trend-total", "e=>e.textContent")
            check("the trend opens with a seven-day bar chart",
                  page2.eval_on_selector("#trend-panel", "e=>e.hidden") is False
                  and cols == 7 and "Last 7 days" in total,
                  "%d bars, %s" % (cols, total))

            # 9. How wide a rule is. A value covers its host and every subdomain
            # of it and nothing else, and a '!host' rule opens a hole in a wider
            # block - which is the baidu.com / pan.baidu.com complaint: blocking
            # baidu.com used to close pan.baidu.com with no way back.
            page2.evaluate("""() => new Promise(res => chrome.runtime.sendMessage(
                {action:'saveRules', rules:[
                    {val:'testsite.invalid', type:'block', mode:'website'},
                    {val:'!pan.testsite.invalid', type:'block', mode:'website'}]}, res))""")
            page2.wait_for_timeout(1200)
            rules9 = sw.evaluate("async () => JSON.stringify(await chrome.declarativeNetRequest.getDynamicRules())")
            check("a website rule asks for its host and its subdomains",
                  '"||testsite.invalid^"' in rules9, rules9[:200])
            check("a '!' rule becomes an allow rule for its own host",
                  '"||pan.testsite.invalid^"' in rules9 and '"allow"' in rules9, rules9[:240])

            # The DNR layer on its own, which is the half content.js cannot save:
            # the old `*://*.host/*` filter never matched the bare host.
            apex = sw.evaluate("""async () => {
                try {
                    const r = await chrome.declarativeNetRequest.testMatchOutcome(
                        {url: 'http://testsite.invalid/', type: 'main_frame'});
                    return JSON.stringify(r.matchedRules.map(m => m.ruleId));
                } catch (e) { return 'unavailable: ' + e.message; }
            }""")
            check("declarativeNetRequest itself covers the bare host",
                  apex.startswith('[') and apex != '[]', apex)

            def visit(url):
                t = ctx.new_page()
                try:
                    t.goto(url, wait_until="domcontentloaded", timeout=15000)
                except Exception:
                    pass
                t.wait_for_timeout(900)
                on_block_page = "blockpage.html" in t.url
                shows_marker = (not on_block_page) and ("marker page" in t.content())
                t.close()
                return on_block_page, shows_marker

            for host, want_blocked in [
                    ("testsite.invalid", True), ("www.testsite.invalid", True),
                    ("mail.testsite.invalid", True),
                    ("pan.testsite.invalid", False), ("a.pan.testsite.invalid", False),
                    ("nottestsite.invalid", False),
                    ("testsite.invalid.evil.invalid", False)]:
                blocked, marked = visit("http://%s/" % host)
                if want_blocked:
                    check("blocked: %s" % host, blocked, "landed on %s" % blocked)
                else:
                    check("stays reachable: %s" % host, marked,
                          "blocked=%s marker=%s" % (blocked, marked))

            # Give any tab/alarm-driven rule sync a chance to blow up.
            entry.wait_for_timeout(2000)
            check("no service-worker console errors", not sw_errors, str(sw_errors[:3]))
            check("no uncaught page errors", not errors, str(errors))
        finally:
            ctx.close()
            marker.shutdown()

    passed = sum(1 for r in results if r)
    print("\n==== %d/%d checks passed ====" % (passed, len(results)))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
