# docs/

Development documentation. **Nothing in this folder is part of the shipped
extension**; a store upload needs only the files the manifest names.

- `../HANDOFF.md` - the current state of the code: storage keys, the pomodoro
  state machine, the rules that must not be broken, and how to verify them.
- `../PRODUCT-REVIEW.md` - the product review and the four-tier roadmap this
  folder's other contents came from.
- `legacy/` - superseded files, kept for their history rather than their code:
  - `manifest-back.json`, `maniback up.json` - older manifests (v1.5, v1.65).
  - `streaks-back.js` - the popup script before the settings page existed.
  - `POMODORO-PLAN.md` - the original pomodoro plan. Its "card inside the
    popup" layout was rejected (the user's rule is that the existing layout
    does not change), so it is a decision record, not a spec.