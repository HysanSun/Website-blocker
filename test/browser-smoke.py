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
import os
import sys
import time

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("playwright is not installed: pip install playwright && playwright install chromium")

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, os.pardir))
PROFILE = os.path.join(os.environ.get("TEMP", "/tmp"), "blocker-smoke-%d" % time.time())

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print("  %s %s %s" % ("PASS" if ok else "FAIL", name, detail))


def main():
    print("extension:", EXT)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE,
            headless=False,  # extensions are unsupported in the headless shell
            args=["--disable-extensions-except=" + EXT, "--load-extension=" + EXT],
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

            # 4. Blocking: a DNR redirect must land on blockpage.html.
            probe = ctx.new_page()
            online = True
            try:
                probe.goto("https://example.com", wait_until="domcontentloaded", timeout=15000)
            except Exception:
                online = False
            if not online:
                print("  SKIP  DNR redirect check (example.com is unreachable)")
            else:
                page.evaluate("""() => new Promise(res => chrome.runtime.sendMessage(
                    {action:'saveRules',
                     rules:[{val:'example.com', type:'block', mode:'website'}]}, res))""")
                page.wait_for_timeout(1500)
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

            check("no uncaught page errors", not errors, str(errors))
        finally:
            ctx.close()

    passed = sum(1 for r in results if r)
    print("\n==== %d/%d checks passed ====" % (passed, len(results)))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
