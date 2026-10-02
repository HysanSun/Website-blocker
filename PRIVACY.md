# Privacy statement

Website Blocker is a local tool. It has no server, no account, and no
analytics. Nothing it records is ever sent anywhere.

## What it stores, and where

| Data | Where | Why |
|---|---|---|
| Your rules (site, keyword, daily limit, time window) | `storage.sync` | So the rules follow your Chrome profile. |
| Pomodoro settings (lengths, auto-start, chime) | `storage.sync` | Same. |
| Today's per-site usage, to the second | `storage.local` | To enforce a daily limit. Cleared every midnight. |
| Pomodoro state and your to-do list | `storage.local` | So a browser restart does not lose them. |
| The 90-day trend (sessions, minutes, which host you ran out of time on) | `storage.local` | To show the Trend card. Pruned to 90 days. |
| Temporary unlocks and their expiry | `storage.local` | To re-lock a site automatically. |
| Streak start date and liveness marks | `storage.local` / `storage.session` | To keep an honest day counter. |

`storage.sync` is Chrome's own profile sync: if you have Chrome Sync on, those
two items go to Google along with the rest of your Chrome data, under Google's
policy, not ours. `storage.local` never leaves the machine.

## What it never does

- No `fetch`, `XMLHttpRequest`, `WebSocket` or `sendBeacon` anywhere in the
  code. The phase chime is synthesised with WebAudio, not downloaded.
- No analytics, crash reporting, or remote configuration.
- No third-party services, no ads, no affiliate links.
- It does not read page content. `content.js` reads only `location.hostname`,
  `location.href` and Chrome's storage to decide whether the site is on your
  own list - it never looks at the DOM, form fields, or anything you type.

## Why the scary permissions

- `host_permissions: <all_urls>` - a blocker has to be able to see a
  navigation before it happens, and it cannot know in advance which sites you
  will put on the list. This permission is used only to compare the host being
  visited against the rules you wrote.
- `tabs` - to notice which tab is in front so time is charged to the site you
  are actually looking at, and to send an already-open tab to the blocked page
  when a limit runs out. Only the URL of the active tab is read, and only its
  host is compared against your rules.
- `declarativeNetRequest` - Chrome's own blocking engine. Your rules are handed
  to it; pages are never proxied through this extension.
- `alarms` - a once-a-minute tick, so limits work with no page open.
- `notifications` - the "time limit almost up" warning and the phase change
  notice. Nothing is pushed; these are created locally.
- `offscreen` - a hidden page whose only job is to play the optional chime,
  because a service worker cannot play audio.

## Deleting your data

Removing the extension deletes `storage.local` and `storage.sync` with it. Use
**Settings -> Backup -> Export data** first: it writes everything, including the
trend, to a single JSON file that never leaves your disk unless you move it.