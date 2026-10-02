// ============================================================
// offscreen.js - the phase chime.
//
// Chrome parks a service worker that has been idle, and a parked worker cannot
// play a sound, so the tone is generated here instead. The note is synthesised
// with WebAudio rather than shipped as an audio file: no asset to load, no
// request, and the whole extension stays offline.
// ============================================================
(function () {
    'use strict';

    var ctx = null;

    function chime(kind) {
        try {
            if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (ctx.state === 'suspended') ctx.resume();
            // Two notes: rising for "back to work", falling for "rest".
            var notes = (kind === 'focus') ? [660, 880] : [880, 660];
            var start = ctx.currentTime;
            notes.forEach(function (freq, i) {
                var osc = ctx.createOscillator();
                var gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                var t = start + i * 0.18;
                gain.gain.setValueAtTime(0.0001, t);
                gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
                osc.connect(gain).connect(ctx.destination);
                osc.start(t);
                osc.stop(t + 0.18);
            });
        } catch (err) {
            // A chime that does not play is not worth reporting anywhere.
        }
    }

    chrome.runtime.onMessage.addListener(function (message) {
        if (message && message.action === 'playChime') chime(message.kind);
    });
})();