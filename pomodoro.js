// ============================================================
// pomodoro.js - UI for pomodoro.html (timer, todo list, settings).
//
// All state lives in the background service worker; this page only renders it
// and sends messages. The per-second interval below is safe here because this
// is a real page - the service worker itself never counts down in memory.
// ============================================================
(function () {
    'use strict';

    var el = function (id) { return document.getElementById(id); };

    var clockEl = el('clock');
    var phaseEl = el('phase-label');
    var dotsEl = el('cycle-dots');
    var taskLine = el('task-line');
    var primaryBtn = el('primary-btn');
    var skipBtn = el('skip-btn');
    var stopBtn = el('stop-btn');
    var todayLine = el('today-line');
    var notifyHint = el('notify-hint');
    var taskInput = el('task-input');
    var taskAdd = el('task-add');
    var taskList = el('task-list');
    var doneList = el('done-list');
    var clearDone = el('clear-done');
    var printBtn = el('print-tasks');
    var settingsToggle = el('settings-toggle');
    var settingsPanel = el('settings-panel');
    var settingsCaret = el('settings-caret');
    var saveSettingsBtn = el('save-settings');
    var manualToggle = el('manual-toggle');
    var manualPanel = el('manual-panel');
    var manualCaret = el('manual-caret');
    var runLine = el('run-line');
    var focusNote = el('focus-note');
    var reviewCard = el('review-card');
    var reviewText = el('review-text');
    var reviewDone = el('review-done');
    var reviewContinue = el('review-continue');
    var reviewLater = el('review-later');
    var planModal = el('plan-modal');
    var planTitle = el('plan-title');
    var planSub = el('plan-sub');
    var planEstimate = el('plan-estimate');
    var planUnits = el('plan-units');
    var planHint = el('plan-hint');
    var planAll = el('plan-all');
    var planAllN = el('plan-all-n');
    var planStart = el('plan-start');
    var planCancel = el('plan-cancel');
    var trendToggle = el('trend-toggle');
    var trendPanel = el('trend-panel');
    var trendCaret = el('trend-caret');
    var trendTotal = el('trend-total');
    var trendBars = el('trend-bars');
    var trendBlocks = el('trend-blocks');

    var state = null;
    var settings = null;
    var tasks = [];
    var tickInFlight = false;
    var pauseMaxMs = 2 * 60 * 1000;
    var editingId = null;
    var planTaskId = null;

    // ------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------
    function send(message) {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage(message, function (res) {
                resolve(res || { success: false });
            });
        });
    }

    function clockText(ms) {
        var total = Math.max(0, Math.ceil(ms / 1000));
        var m = Math.floor(total / 60);
        var s = total % 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function taskById(id) {
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i] && tasks[i].id === id) return tasks[i];
        }
        return null;
    }

    function isPaused(s) {
        return s.pausedRemainingMs !== null && s.pausedRemainingMs !== undefined;
    }

    function remainingOf(s) {
        if (s.phase === 'idle') return 0;
        if (isPaused(s)) return Math.max(0, s.pausedRemainingMs);
        return Math.max(0, s.endAt - Date.now());
    }

    function phaseLabel(s) {
        var paused = isPaused(s);
        if (s.phase === 'focus') return paused ? 'Focus (paused)' : 'Focus';
        if (s.phase === 'shortBreak') return paused ? 'Break (paused)' : 'Short break';
        if (s.phase === 'longBreak') return paused ? 'Long break (paused)' : 'Long break';
        return 'Idle';
    }

    function currentTask() {
        if (!state || !state.taskId) return null;
        for (var i = 0; i < tasks.length; i++) {
            if (tasks[i].id === state.taskId) return tasks[i];
        }
        return null;
    }

    // ------------------------------------------------------------
    // Render
    // ------------------------------------------------------------
    function renderTimer() {
        if (!state || !settings) return;
        var running = state.phase !== 'idle';
        var onBreak = state.phase === 'shortBreak' || state.phase === 'longBreak';

        clockEl.textContent = running ? clockText(remainingOf(state)) : clockText(settings.focusMin * 60000);
        clockEl.className = onBreak ? 'on-break' : '';
        phaseEl.textContent = phaseLabel(state);

        var cycles = settings.cyclesUntilLongBreak;
        var done = state.cycleDone % cycles;
        var dots = '';
        for (var i = 0; i < cycles; i++) dots += (i < done ? '\u25CF' : '\u25CB');
        dotsEl.textContent = dots;

        var task = currentTask();
        taskLine.textContent = task ? task.text : (running ? 'No task selected' : '');

        primaryBtn.textContent = !running ? 'Start' : (isPaused(state) ? 'Resume' : 'Pause');
        // One pause per focus session, and the worker refuses a second one; the
        // greyed-out button is how the user finds that out before clicking.
        var pauseSpent = state.phase === 'focus' && !isPaused(state) && !!state.pauseUsed;
        primaryBtn.disabled = pauseSpent;
        primaryBtn.title = pauseSpent
            ? 'This focus session has already used its one pause.'
            : '';
        stopBtn.disabled = !running;
        // Only breaks can be skipped. A focus session has to be seen through;
        // Stop is the honest way out of one (it records nothing).
        skipBtn.disabled = !running || state.phase === 'focus';
        skipBtn.title = state.phase === 'focus'
            ? 'A focus session cannot be skipped. Use Stop to give it up.'
            : 'Skip the rest of this break';
        if (state.phase === 'focus' && isPaused(state) && state.pauseEndsAt) {
            // The pause is on its own clock: say so, with the time left.
            focusNote.textContent = 'Paused \u2014 the clock restarts itself in ' +
                clockText(state.pauseEndsAt - Date.now()) + '. One pause per session, ' +
                Math.round(pauseMaxMs / 60000) + ' minutes at most.';
            focusNote.hidden = false;
        } else {
            focusNote.textContent = 'Focus cannot be skipped \u2014 Stop gives the run up.';
            focusNote.hidden = state.phase !== 'focus';
        }

        var run = state.run;
        if (run && run.taskId) {
            var doneUnits = run.focusDone || 0;
            runLine.textContent = 'This run: ' + doneUnits + ' of ' + run.units + ' units done' +
                (state.phase === 'focus' ? ' \u00B7 unit ' + Math.min(run.units, doneUnits + 1) : '');
            runLine.hidden = false;
        } else {
            runLine.hidden = true;
        }

        todayLine.textContent = 'Today: ' + state.focusToday + ' sessions \u00B7 ' +
            Math.round(state.focusMsToday / 60000) + ' min';
    }

    function taskRow(t, index, total, isDone) {
        var active = !isDone && state && state.taskId === t.id && state.phase !== 'idle';
        var html = '<div class="task' + (active ? ' active' : '') + '" data-id="' + t.id + '">';

        if (isDone) {
            html += '<input type="checkbox" checked data-act="toggle">';
        } else {
            html += '<button class="play" data-act="play" title="Focus on this task">&#9654;</button>';
            html += '<input type="checkbox" data-act="toggle">';
        }

        html += '<span class="text" data-act="rename" title="Double-click to rename">' +
            escapeHtml(t.text) + '</span>';
        html += '<span class="meta"' + (isDone ? '' : ' data-act="plan"') +
            ' title="' + (isDone ? '' : 'Click to plan this task') + '">' +
            unitText(t) + '</span>';

        if (!isDone) {
            html += '<button data-act="up"' + (index === 0 ? ' disabled' : '') + '>&#9650;</button>';
            html += '<button data-act="down"' + (index === total - 1 ? ' disabled' : '') + '>&#9660;</button>';
        }
        html += '<button data-act="remove" title="Delete">&#10005;</button>';
        html += '</div>';
        return html;
    }

    function renderTasks() {
        var active = tasks.filter(function (t) { return t && !t.done; });
        var done = tasks.filter(function (t) { return t && t.done; })
            .sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });

        if (active.length === 0) {
            taskList.innerHTML = '<div class="empty">No tasks yet. Add one and press play to focus on it.</div>';
        } else {
            taskList.innerHTML = active.map(function (t, i) {
                return taskRow(t, i, active.length, false);
            }).join('');
        }

        if (done.length === 0) {
            doneList.innerHTML = '<div class="empty">Nothing completed yet.</div>';
            clearDone.style.display = 'none';
        } else {
            doneList.innerHTML = done.map(function (t) { return taskRow(t, 0, 0, true); }).join('');
            clearDone.style.display = 'inline-block';
        }

        bindTaskEvents();
    }

    // ------------------------------------------------------------
    // Printing the list
    //
    // The page is the app; the paper should be the list. The button builds a
    // plain sheet (#print-sheet) and the print rules in pomodoro.html hide
    // everything else for the duration of the job. No worker round-trip: this
    // is a local view of state the page already has.
    // ------------------------------------------------------------
    function unitText(t) {
        var credited = t.pomodoros || 0;
        var planned = t.plannedUnits || 0;
        return credited + (planned > 0 ? '/' + planned : '') + ' \uD83C\uDF45 \u00B7 ' +
            Math.round((t.focusMs || 0) / 60000) + ' min';
    }

    function printRow(t, isDone) {
        return '<li' + (isDone ? ' class="done"' : '') + '>' +
            '<span class="box">' + (isDone ? '\u2611' : '\u2610') + '</span>' +
            '<span class="text">' + escapeHtml(t.text) + '</span>' +
            '<span class="meta">' + unitText(t) + '</span></li>';
    }

    function buildPrintSheet() {
        var sheet = el('print-sheet');
        if (!sheet) {
            sheet = document.createElement('div');
            sheet.id = 'print-sheet';
            document.body.appendChild(sheet);
        }

        var active = tasks.filter(function (t) { return t && !t.done; });
        var done = tasks.filter(function (t) { return t && t.done; })
            .sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });

        // Active tasks keep the order the user arranged; finished ones read as
        // a record of the day, so they come last and stay crossed out.
        var html = '<h1>To-do list</h1>';
        html += '<p class="print-meta">' + new Date().toLocaleDateString() + ' \u00B7 ' +
            active.length + ' open' + (done.length ? ' \u00B7 ' + done.length + ' done' : '') +
            '</p>';
        if (active.length) {
            html += '<ul>' + active.map(function (t) { return printRow(t, false); }).join('') + '</ul>';
        } else {
            html += '<p class="print-empty">Nothing open.</p>';
        }
        if (done.length) {
            html += '<h2>Completed</h2><ul>' +
                done.map(function (t) { return printRow(t, true); }).join('') + '</ul>';
        }
        html += '<p class="print-foot">Website Blocker \u00B7 Pomodoro</p>';

        sheet.innerHTML = html;
        return sheet;
    }

    function printTasks() {
        if (tasks.length === 0) {
            if (window.WB) WB.toast('Nothing to print yet');
            return;
        }
        buildPrintSheet();
        // The class is what the print rules key off, so a normal Ctrl+P (which
        // never sets it) still prints the page exactly as it looks on screen.
        document.body.classList.add('printing');
        // window.print() blocks until the dialog closes, so this is the normal
        // way back; afterprint covers the builds that return early instead.
        var restore = function () {
            document.body.classList.remove('printing');
            window.removeEventListener('afterprint', restore);
        };
        window.addEventListener('afterprint', restore);
        window.print();
        restore();
    }

    function renderSettings() {
        if (!settings) return;
        el('s-focus').value = settings.focusMin;
        el('s-short').value = settings.shortBreakMin;
        el('s-long').value = settings.longBreakMin;
        el('s-cycles').value = settings.cyclesUntilLongBreak;
        el('s-autobreak').checked = !!settings.autoStartBreak;
        el('s-autofocus').checked = !!settings.autoStartFocus;
        el('s-strict').checked = !!settings.focusBlocksTimed;
        el('s-sound').checked = !!settings.soundOn;
    }

    // ------------------------------------------------------------
    // Review: the planned units are spent - ask about the task
    // ------------------------------------------------------------
    function renderReview() {
        if (!reviewCard) return;
        var review = state && state.review;
        var task = review ? taskById(review.taskId) : null;
        if (!task || task.done) {
            reviewCard.hidden = true;
            return;
        }
        var credited = task.pomodoros || 0;
        reviewText.textContent = '\u201C' + task.text + '\u201D reached the ' + credited +
            ' unit(s) you planned. Is it finished?';
        reviewCard.hidden = false;
    }

    function answerReview(mode, thenPlan) {
        var id = (state && state.review) ? state.review.taskId : null;
        send({ action: 'pomodoroReviewAnswer', mode: mode })
            .then(applyStatus)
            .then(applyTasks)
            .then(function () {
                // "Not yet" means the user wants to re-plan: the dialog opens
                // with the estimate one unit above what is already credited.
                if (thenPlan && id) openPlanDialog(id);
            });
    }

    // ------------------------------------------------------------
    // Plan dialog: one row per task, "how many units is this worth?"
    // ------------------------------------------------------------
    function planCap(task, estimate) {
        var credited = (task && task.pomodoros) || 0;
        var planned = (isFinite(estimate) && estimate > 0) ? estimate : 1;
        return Math.max(1, planned - credited);
    }

    // Redraw what depends on the two inputs, but never rewrite the field the
    // user is typing in: clearing a number input to retype it would otherwise
    // snap back to a value and swallow the next keystroke ("3" became "13").
    function syncPlanDialog(source) {
        var task = taskById(planTaskId);
        var estimate = parseInt(planEstimate.value, 10);
        var valid = isFinite(estimate) && estimate >= 1;
        if (!valid && source !== planEstimate) {
            estimate = 1;
            valid = true;
            planEstimate.value = estimate;
        }
        var cap = planCap(task, valid ? estimate : 1);
        if (source !== planUnits) {
            var units = parseInt(planUnits.value, 10);
            if (!isFinite(units) || units < 1) units = cap;
            planUnits.value = Math.min(units, cap);
        }
        planUnits.max = cap;
        planAllN.textContent = cap;
        var credited = (task && task.pomodoros) || 0;
        var raised = valid && estimate < credited;
        planHint.textContent = '1 unit = ' + settings.focusMin + ' min focus + ' +
            settings.shortBreakMin + ' min break. ' + credited + ' unit(s) already credited.' +
            (raised ? ' A plan below that is kept at ' + credited + '.' : '');
    }

    function openPlanDialog(taskId) {
        var task = taskById(taskId);
        // One timer at a time: starting a run replaces whatever is running, and
        // silently resetting a live session is never what the user meant.
        if (!task || !state || state.phase !== 'idle') return;
        planTaskId = taskId;
        var credited = task.pomodoros || 0;
        var planned = task.plannedUnits || 0;
        planTitle.textContent = task.text;
        planSub.textContent = planned > 0
            ? 'Planned ' + planned + ' unit(s), ' + credited + ' credited.'
            : 'No estimate yet: how many units is this task worth?';
        planEstimate.value = planned > 0 ? Math.max(planned, credited + 1) : Math.max(1, credited + 1);
        planUnits.value = planCap(task, parseInt(planEstimate.value, 10));
        syncPlanDialog();
        planModal.hidden = false;
        planUnits.focus();
        planUnits.select();
    }

    function closePlanDialog() {
        planModal.hidden = true;
        planTaskId = null;
    }

    // ------------------------------------------------------------
    // Trend (a local-only, 90-day day-by-day record)
    // ------------------------------------------------------------
    function dayKeyOf(date) {
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    }

    function durationText(ms) {
        var mins = Math.round(ms / 60000);
        if (mins < 60) return mins + 'm';
        var h = Math.floor(mins / 60);
        var m = mins % 60;
        return h + 'h' + (m ? ' ' + m + 'm' : '');
    }

    function renderTrend(days) {
        if (!trendBars) return;
        var DAY_INITIAL = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        var week = [];
        var i;
        for (i = 6; i >= 0; i--) {
            var d = new Date();
            d.setDate(d.getDate() - i);
            var key = dayKeyOf(d);
            var rec = days[key] || {};
            week.push({
                key: key,
                label: DAY_INITIAL[d.getDay()],
                focusMs: rec.focusMs || 0,
                sessions: rec.sessions || 0,
                blocks: rec.blocks || {},
                today: i === 0
            });
        }

        var totalMs = 0;
        var totalSessions = 0;
        var blockCounts = {};
        week.forEach(function (day) {
            totalMs += day.focusMs;
            totalSessions += day.sessions;
            for (var host in day.blocks) {
                if (!Object.prototype.hasOwnProperty.call(day.blocks, host)) continue;
                blockCounts[host] = (blockCounts[host] || 0) + day.blocks[host];
            }
        });

        trendTotal.textContent = totalSessions
            ? 'Last 7 days: ' + totalSessions + ' session' + (totalSessions === 1 ? '' : 's') +
              ' \u00b7 ' + durationText(totalMs) + ' focused'
            : 'Last 7 days: nothing recorded yet.';

        var max = 1;
        week.forEach(function (day) { if (day.focusMs > max) max = day.focusMs; });
        var html = '';
        week.forEach(function (day) {
            var pct = Math.round((day.focusMs / max) * 100);
            html += '<div class="trend-col' + (day.today ? ' today' : '') + '" title="' +
                day.key + ': ' + (day.sessions || 0) + ' session(s)">';
            html += '<div class="bar' + (day.focusMs ? '' : ' empty') + '" style="height:' +
                (day.focusMs ? Math.max(4, pct) : 2) + '%"></div>';
            html += '<div class="day">' + day.label + '</div></div>';
        });
        trendBars.innerHTML = html;

        var worst = null;
        for (var host in blockCounts) {
            if (!Object.prototype.hasOwnProperty.call(blockCounts, host)) continue;
            if (!worst || blockCounts[host] > blockCounts[worst]) worst = host;
        }
        trendBlocks.textContent = worst
            ? 'Ran out of time most often on ' + worst + ' (' + blockCounts[worst] + ' time' +
              (blockCounts[worst] === 1 ? '' : 's') + ').'
            : '';
    }

    function refreshTrend() {
        return send({ action: 'getStats' }).then(function (res) {
            if (res && res.success) renderTrend(res.days || {});
            return res;
        });
    }

    // ------------------------------------------------------------
    // Data flow
    // ------------------------------------------------------------
    function applyStatus(res) {
        if (res && res.success && res.state) {
            state = res.state;
            settings = res.settings;
            if (res.pauseMaxMs) pauseMaxMs = res.pauseMaxMs;
            renderTimer();
            renderReview();
            // Notifications are optional: Chrome only hands over the API once
            // the permission is granted, and reloading an unpacked extension
            // after adding one does not grant it. Say so instead of going
            // quiet about it.
            if (notifyHint) notifyHint.hidden = res.notifications !== false;
        }
        return res;
    }

    function applyTasks(res) {
        if (res && res.tasks) {
            tasks = res.tasks;
            renderTasks();
            renderTimer();
            renderReview();
        }
        return res;
    }

    function refresh() {
        return send({ action: 'pomodoroGetState' })
            .then(applyStatus)
            .then(function () { return send({ action: 'todoGet' }); })
            .then(applyTasks)
            .then(refreshTrend);
    }

    function act(action, extra) {
        var message = Object.assign({ action: action }, extra || {});
        return send(message).then(applyStatus);
    }

    // ------------------------------------------------------------
    // Task interactions
    // ------------------------------------------------------------
    function beginRename(span, id) {
        if (editingId) return;
        editingId = id;

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'edit';
        input.maxLength = 200;
        input.value = span.textContent;
        span.parentNode.replaceChild(input, span);
        input.focus();
        input.select();

        function commit(save) {
            if (!editingId) return;
            editingId = null;
            if (save && input.value.trim()) {
                send({ action: 'todoUpdate', id: id, text: input.value }).then(applyTasks);
            } else {
                renderTasks();
            }
        }

        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') commit(true);
            else if (e.key === 'Escape') commit(false);
        });
        input.addEventListener('blur', function () { commit(true); });
    }

    function bindTaskEvents() {
        var rows = document.querySelectorAll('.task');
        for (var i = 0; i < rows.length; i++) {
            (function (row) {
                var id = row.getAttribute('data-id');
                row.addEventListener('click', function (e) {
                    var target = e.target.closest ? e.target.closest('[data-act]') : null;
                    if (!target) return;
                    var act1 = target.getAttribute('data-act');
                    if (act1 === 'play' || act1 === 'plan') {
                        openPlanDialog(id);
                    } else if (act1 === 'toggle') {
                        send({ action: 'todoToggle', id: id }).then(applyTasks);
                    } else if (act1 === 'up') {
                        send({ action: 'todoMove', id: id, direction: 'up' }).then(applyTasks);
                    } else if (act1 === 'down') {
                        send({ action: 'todoMove', id: id, direction: 'down' }).then(applyTasks);
                    } else if (act1 === 'remove') {
                        send({ action: 'todoRemove', id: id }).then(applyTasks);
                    }
                });
                row.addEventListener('dblclick', function (e) {
                    var target = e.target.closest ? e.target.closest('[data-act="rename"]') : null;
                    if (target) beginRename(target, id);
                });
            })(rows[i]);
        }
    }

    function addTask() {
        var text = taskInput.value;
        if (!text.trim()) return;
        taskInput.value = '';
        send({ action: 'todoAdd', text: text }).then(applyTasks);
    }

    // ------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------
    primaryBtn.addEventListener('click', function () {
        if (!state) return;
        if (state.phase === 'idle') act('pomodoroStart');
        else if (isPaused(state)) act('pomodoroResume');
        else act('pomodoroPause');
    });

    skipBtn.addEventListener('click', function () { act('pomodoroSkip'); });
    stopBtn.addEventListener('click', function () { act('pomodoroStop'); });

    reviewDone.addEventListener('click', function () { answerReview('done'); });
    reviewContinue.addEventListener('click', function () { answerReview('continue', true); });
    reviewLater.addEventListener('click', function () { answerReview('later'); });

    planEstimate.addEventListener('input', function () { syncPlanDialog(planEstimate); });
    planUnits.addEventListener('input', function () { syncPlanDialog(planUnits); });
    planAll.addEventListener('click', function () {
        planUnits.value = planAllN.textContent;
        syncPlanDialog(planUnits);
    });
    planCancel.addEventListener('click', closePlanDialog);
    planModal.addEventListener('click', function (e) {
        if (e.target === planModal) closePlanDialog();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !planModal.hidden) closePlanDialog();
    });
    planStart.addEventListener('click', function () {
        if (!planTaskId) return;
        var task = taskById(planTaskId);
        var credited = (task && task.pomodoros) || 0;
        var estimate = parseInt(planEstimate.value, 10);
        if (!isFinite(estimate) || estimate < 1) estimate = 1;
        if (estimate < credited) estimate = credited;
        var units = parseInt(planUnits.value, 10);
        if (!isFinite(units) || units < 1) units = 1;
        var cap = planCap(task, estimate);
        if (units > cap) units = cap;
        var id = planTaskId;
        closePlanDialog();
        send({ action: 'pomodoroStart', taskId: id, units: units, planUnits: estimate })
            .then(applyStatus)
            .then(applyTasks);
    });

    taskAdd.addEventListener('click', addTask);
    printBtn.addEventListener('click', printTasks);
    taskInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addTask();
    });

    // Deleting finished tasks is not undoable, so the button asks twice.
    if (window.WB) {
        WB.armButton(clearDone, 'Click again to delete', function () {
            send({ action: 'todoClearDone' }).then(applyTasks);
        });
    }

    settingsToggle.addEventListener('click', function () {
        settingsPanel.hidden = !settingsPanel.hidden;
        settingsCaret.textContent = settingsPanel.hidden ? '\u25BE' : '\u25B4';
    });

    manualToggle.addEventListener('click', function () {
        manualPanel.hidden = !manualPanel.hidden;
        manualCaret.textContent = manualPanel.hidden ? '\u25BE' : '\u25B4';
    });

    trendToggle.addEventListener('click', function () {
        trendPanel.hidden = !trendPanel.hidden;
        trendCaret.textContent = trendPanel.hidden ? '\u25BE' : '\u25B4';
    });

    saveSettingsBtn.addEventListener('click', function () {
        var payload = {
            focusMin: parseInt(el('s-focus').value, 10),
            shortBreakMin: parseInt(el('s-short').value, 10),
            longBreakMin: parseInt(el('s-long').value, 10),
            cyclesUntilLongBreak: parseInt(el('s-cycles').value, 10),
            autoStartBreak: el('s-autobreak').checked,
            autoStartFocus: el('s-autofocus').checked,
            focusBlocksTimed: el('s-strict').checked,
            soundOn: el('s-sound').checked
        };
        act('pomodoroSaveSettings', { settings: payload }).then(function (res) {
            if (!res || !res.success) { if (window.WB) WB.error('Could not save the settings'); return; }
            renderSettings();
            // The caret used to turn into "saved" for 1.5s, which took the
            // collapse control away and said it in a second visual language.
            if (window.WB) WB.ok('Timer settings saved');
        });
    });

    // Local countdown. When the deadline passes, ask the worker to do the
    // transition rather than waiting for its next alarm.
    setInterval(function () {
        if (!state || state.phase === 'idle') return;
        if (isPaused(state)) {
            // A limited pause ends on its own, and the worker owns that
            // transition (its own alarm restarts the clock even with this page
            // closed). All this page has to do is keep the countdown moving and
            // adopt whatever the worker decided.
            if (state.pauseEndsAt && Date.now() >= state.pauseEndsAt && !tickInFlight) {
                tickInFlight = true;
                send({ action: 'pomodoroTick' }).then(function (res) {
                    tickInFlight = false;
                    applyStatus(res);
                });
                return;
            }
            renderTimer();
            return;
        }
        if (remainingOf(state) > 0) { renderTimer(); return; }
        if (tickInFlight) return;
        tickInFlight = true;
        send({ action: 'pomodoroTick' }).then(function (res) {
            tickInFlight = false;
            applyStatus(res);
            return send({ action: 'todoGet' }).then(applyTasks).then(refreshTrend);
        });
    }, 1000);

    refresh().then(renderSettings);
})();
