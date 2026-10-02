// ============================================================
// ui.js - the one feedback channel.
//
// The extension used to report "done" five different ways: a toast on the
// settings page, a fixed-height line in the popup, a caret that briefly turned
// into "saved", a native alert and a native confirm. Every page now loads this
// file and calls WB.toast, so a message looks and behaves the same wherever it
// comes from.
// ============================================================
(function () {
    'use strict';

    var node = null;
    var hideTimer = null;

    function element() {
        if (node && node.parentNode) return node;
        node = document.createElement('div');
        node.className = 'wb-toast';
        // role=status announces the message without stealing focus.
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        document.body.appendChild(node);
        return node;
    }

    // kind: 'success' | 'error' | anything falsy for the neutral style.
    function toast(text, kind, ms) {
        if (!text) return;
        var el = element();
        el.textContent = String(text);
        el.className = 'wb-toast' + (kind ? ' ' + kind : '');
        // Restart the transition when a second message replaces the first one.
        void el.offsetWidth;
        el.classList.add('show');
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            hideTimer = null;
            el.classList.remove('show');
        }, ms || 2600);
    }

    // A destructive action that cannot be undone gets a second click instead of
    // a native confirm(): the button says what the next click will do.
    function armButton(btn, armedLabel, action) {
        if (!btn) return;
        var original = btn.textContent;
        var armed = false;
        btn.addEventListener('click', function () {
            if (!armed) {
                armed = true;
                btn.textContent = armedLabel;
                setTimeout(function () {
                    if (!armed) return;
                    armed = false;
                    btn.textContent = original;
                }, 4000);
                return;
            }
            armed = false;
            btn.textContent = original;
            action();
        });
    }

    window.WB = {
        toast: toast,
        ok: function (text) { toast(text, 'success'); },
        error: function (text) { toast(text, 'error'); },
        armButton: armButton
    };
})();