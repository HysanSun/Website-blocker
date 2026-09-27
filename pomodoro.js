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
    var taskInput = el('task-input');
    var taskAdd = el('task-add');
    var taskList = el('task-list');
    var doneList = el('done-list');
    var clearDone = el('clear-done');
    var settingsToggle = el('settings-toggle');
    var settingsPanel = el('settings-panel');
    var settingsCaret = el('settings-caret');
    var saveSettingsBtn = el('save-settings');

    var state = null;
    var settings = null;
    var tasks = [];
    var tickInFlight = false;
    var editingId = null;

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
        skipBtn.disabled = !running;
        stopBtn.disabled = !running;

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
        html += '<span class="meta">' + (t.pomodoros || 0) + ' \uD83C\uDF45 \u00B7 ' +
            Math.round((t.focusMs || 0) / 60000) + ' min</span>';

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

    function renderSettings() {
        if (!settings) return;
        el('s-focus').value = settings.focusMin;
        el('s-short').value = settings.shortBreakMin;
        el('s-long').value = settings.longBreakMin;
        el('s-cycles').value = settings.cyclesUntilLongBreak;
        el('s-autobreak').checked = !!settings.autoStartBreak;
        el('s-autofocus').checked = !!settings.autoStartFocus;
        el('s-strict').checked = !!settings.focusBlocksTimed;
    }

    // ------------------------------------------------------------
    // Data flow
    // ------------------------------------------------------------
    function applyStatus(res) {
        if (res && res.success && res.state) {
            state = res.state;
            settings = res.settings;
            renderTimer();
        }
        return res;
    }

    function applyTasks(res) {
        if (res && res.tasks) {
            tasks = res.tasks;
            renderTasks();
            renderTimer();
        }
        return res;
    }

    function refresh() {
        return send({ action: 'pomodoroGetState' })
            .then(applyStatus)
            .then(function () { return send({ action: 'todoGet' }); })
            .then(applyTasks);
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
                    if (act1 === 'play') {
                        act('pomodoroStart', { taskId: id }).then(function () { renderTimer(); });
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

    taskAdd.addEventListener('click', addTask);
    taskInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') addTask();
    });

    clearDone.addEventListener('click', function () {
        send({ action: 'todoClearDone' }).then(applyTasks);
    });

    settingsToggle.addEventListener('click', function () {
        settingsPanel.hidden = !settingsPanel.hidden;
        settingsCaret.textContent = settingsPanel.hidden ? '\u25BE' : '\u25B4';
    });

    saveSettingsBtn.addEventListener('click', function () {
        var payload = {
            focusMin: parseInt(el('s-focus').value, 10),
            shortBreakMin: parseInt(el('s-short').value, 10),
            longBreakMin: parseInt(el('s-long').value, 10),
            cyclesUntilLongBreak: parseInt(el('s-cycles').value, 10),
            autoStartBreak: el('s-autobreak').checked,
            autoStartFocus: el('s-autofocus').checked,
            focusBlocksTimed: el('s-strict').checked
        };
        act('pomodoroSaveSettings', { settings: payload }).then(function (res) {
            if (!res || !res.success) return;
            renderSettings();
            settingsCaret.textContent = '\u2713 saved';
            setTimeout(function () { settingsCaret.textContent = '\u25BE'; }, 1500);
        });
    });

    // Local countdown. When the deadline passes, ask the worker to do the
    // transition rather than waiting for its next alarm.
    setInterval(function () {
        if (!state || state.phase === 'idle' || isPaused(state)) return;
        if (remainingOf(state) > 0) { renderTimer(); return; }
        if (tickInFlight) return;
        tickInFlight = true;
        send({ action: 'pomodoroTick' }).then(function (res) {
            tickInFlight = false;
            applyStatus(res);
            return send({ action: 'todoGet' }).then(applyTasks);
        });
    }, 1000);

    refresh().then(renderSettings);
})();