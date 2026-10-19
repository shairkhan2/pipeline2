# Studio redesign delivery

Implemented on 2026-10-18. This is the first page in the frontend redesign checklist.

## Delivered

- Scoped slate/blue theme with self-hosted Barlow, readable labels, consistent focus treatment, and reduced-motion support.
- Five Studio sections with accessible keyboard navigation and `?tab=` deep links. Back/forward and reload restore the selected section.
- Visited panels retain unsaved routing and prompt drafts. Media pauses when its panel becomes hidden.
- Compact provider summaries, expandable model/access controls, explicit connection status, and a useful empty state.
- Redesigned routing sections, model-picker presentation, render-node controls, voice preview, and prompt workbench.
- Provider and node dialogs with viewport-safe scrolling, persistent action footers, consistent fields, and busy-state dismissal guards.
- Confirmation dialogs for provider/node removal, key revocation, and stop actions, replacing timed inline confirmations.
- Node/storage drawers and change-history styling. Storage recovery copy now names the task directly.
- Unknown worker telemetry no longer displays invented meter fill. Untested nodes show “Configured” instead of “Ready”.
- Dismissible feedback, failed-catalog retry, read-only controls, and mobile wrapping for long subscription actions.

## Screenshots

Screenshots use synthetic API fixtures, not live provider accounts or credentials.

- [Providers, desktop](providers-desktop.png)
- [Provider dialog](provider-dialog-desktop.png)
- [Stage routing](stage-routing-desktop.png)
- [Render nodes](render-nodes-desktop.png)
- [Voice](voice-desktop.png)
- [Prompts](prompts-desktop.png)
- [Providers, mobile](providers-mobile.png)
- [Subscription dialog at 320px](subscription-dialog-320.png)

## Verification

- Passed `npm --prefix frontend run typecheck`.
- Passed `npm --prefix frontend run build -- --outDir /tmp/opencode/studio-redesign-build`.
- Passed Chromium/Playwright fixture-backed checks for all five sections at desktop/mobile sizes, with a 320px reflow pass.
- Checked four provider connection modes and three node kinds for dialog fit and horizontal overflow.
- Checked storage/node drawers, removal confirmation, model-search empty state, and provider-dialog Escape/focus return.
- Checked routing/prompt draft retention, keyboard Home navigation, browser history, reload, and removal of Studio styling after leaving the page.
- Checked empty providers, read-only routing/prompts, catalogue failure, and successful retry. No uncaught page errors in the test run.
- Browser script and additional screenshots: `/tmp/opencode/studio-design-check.py` and `/tmp/opencode/studio-redesign/`.

## Remaining release checks

Live OAuth/device authorization, paid voice synthesis, worker provisioning, actual configuration writes, and storage mutation workflows require authenticated integration checks. These were not exercised against production services. Firefox/WebKit and a screen-reader pass remain open.

The production build reports the existing application-wide bundle-size warning (main bundle approximately 1.03 MB before gzip). Route splitting remains a cross-page optimization task.

Build output was directed to an isolated directory because the configured public output also contains existing preview artifacts. No deployment was performed.
