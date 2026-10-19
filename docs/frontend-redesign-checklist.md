# Frontend redesign: audit and delivery checklist

Status: source audit complete; Studio redesign implemented and fixture-tested. Other pages remain queued.
Created: 2026-10-18.

## Brief and working process

Redesign the complete Screening Room frontend into a polished manhwa production and viewing workspace. Cover every route, nested view, tab, popup, section, and state. Work through the phases in order, reviewing each finished surface before moving on.

Product assumption to confirm: primary users produce narrated manhwa videos, configure providers and render workers, monitor production, and review finished chapters. Library viewers also need a quiet, accessible playback experience.

Checkboxes mean verified completion, not merely code written. For each implementation item, record changed files, screenshots, checks, and remaining defects. Newly discovered surfaces join this checklist before their phase closes.

## Source audit

- [x] Load and apply the frontend-design skill to the planning pass.
- [x] Inventory the six React entry pages and nested library routes.
- [x] Inventory Studio tabs, setup steps, named dialogs, drawers, and playback overlay.
- [x] Locate the separate server-rendered login screen.
- [x] Inspect shared shell, theme tokens, dialog primitives, and storage drawer.
- [ ] Complete a rendered audit of every state listed below.

Evidence limits: the in-app browser timed out opening `http://127.0.0.1:4176`. An HTTP request to that port redirected to `/login`; its identity and authenticated routes still need browser verification. Findings below come from source, not screenshots. No visual or functional checks are claimed complete.

### Findings to address

1. **Identity feels applied rather than product-specific.** Warm coral, serif headlines, tracked uppercase labels, and cinematic slogans recur across operational screens. See `frontend/src/components/layout/AppShell.tsx:178`, `:246`, `:257`, and `src/player/server.ts:273`.
2. **Information hierarchy relies on repeated containers.** Provider configuration, quota accounts, storage rows, and wizard sections use similar rounded panels. Different tasks need different structures: media shelves, editable lists, workbenches, and stage matrices.
3. **Small text carries important information.** Shell labels use 10–11px text; Studio includes 10–11px labels. Establish a readable data density before changing decoration.
4. **Theme changes cannot propagate reliably.** `frontend/src/index.css` defines tokens, but pages and the shell repeat literal colors and inject CSS. Global `.font-serif` and `.chip` rules complicate ownership.
5. **Copy conceals task names.** “Behind every chapter.”, “Beyond the frame.”, and “Storage & /tmp Trash Recovery” need clear, user-facing headings. Explain technical details near the relevant action.
6. **Long dialogs need explicit overflow design.** The shared dialog centers content without its own maximum height or scroll region (`frontend/src/components/ui/dialog.tsx:56`). Provider forms contain many conditional fields. Verify short-screen and mobile behavior.
7. **Destructive actions lack consistent presentation.** Chapter deletion has a dialog; shared trash purge controls call their handlers directly. Review consequence wording, confirmations, pending states, and recovery together.
8. **Unavailable data can resemble empty data.** Storage fetch failures are swallowed into null values (`StorageTrashDrawer.tsx:50–60`). Review unknown, failed, stale, and genuinely empty states independently.
9. **Login is outside the React design system.** Its inline HTML/CSS must receive the same identity and accessibility treatment.
10. **Build output contains mixed assets.** Vite uses `emptyOutDir: true` for `src/player/public`, which currently includes legacy files and preview artifacts. Establish asset ownership before a production build.

## Proposed design direction: a manhwa production desk

The memorable element is the actual chapter artwork, used in a panel-shaped preview strip and media layouts. Surround it with quiet production controls. Operational pages emphasize what is running, what failed, and what action comes next.

### Compact token proposal

Core palette, subject to contrast testing:

| Token | Hex | Role |
| --- | --- | --- |
| Canvas | `#151B26` | Cool, low-glare workspace background |
| Surface | `#202A39` | Controls and meaningful grouped regions |
| Boundary | `#46556C` | Interactive boundaries and separators |
| Text | `#F3F6FC` | Primary content |
| Secondary | `#B0BED2` | Supporting content |
| Action | `#9FB9FF` | Primary controls, selection, keyboard focus |

Define success, warning, and failure tokens separately; pair them with text or icons. Artwork supplies expressive color. Avoid decorative gradients and glow.

Typography: propose self-hosted **Barlow** for controls and body, with **Barlow Condensed** reserved for series titles and the product wordmark. Use tabular numerals for metrics; monospace only for logs, IDs, and code. Confirm font licensing and fallback metrics. Start with 14–16px body, 12px minimum supporting text, and a 16/20/28/40px heading scale. Keep body lines around 60–75 characters.

Layout: left-align operational content. Use a stable navigation rail, a single page heading, contextual actions, and task-specific layouts. Let media views breathe; let configuration views be efficiently dense.

```text
Media workspace
┌────────────┬──────────────────────────────────────────┐
│ Navigation │ Library                 Search / New     │
│            ├──────────────────────────────────────────┤
│            │ Resume: chapter artwork + clear progress │
│            │                                          │
│            │ Series artwork shelf                     │
│            │ Title / chapters / latest result         │
└────────────┴──────────────────────────────────────────┘

Production workspace
┌────────────┬──────────────────────────────────────────┐
│ Navigation │ Pipeline                    Run actions  │
│            ├─────────────────────────┬────────────────┤
│            │ Runs and chapter stages │ Selected run   │
│            │ Failures needing action │ Worker details │
│            │                         │ Relevant logs  │
└────────────┴─────────────────────────┴────────────────┘
```

Mobile: stack details below the active task; use an accessible compact navigation pattern. Keep horizontal scrolling inside genuine tables or timelines, never across the page.

### Design critique before implementation

An initial “cinematic dashboard” direction would reproduce the existing dark cards and decorative headlines. Revise it to a production desk with artwork-led media views and structured operational lists. Do not put an artwork banner on configuration pages merely for consistency. Distinction must come from chapter content and production workflow, not a palette swap.

- [ ] Confirm the audience, proposed visual direction, and continued use of the Screening Room name.
- [ ] Produce desktop and mobile shell/library studies with real, authorized artwork.
- [ ] Compare against the existing design and remove any remaining template-like decoration.

## Phase 0 — Baseline and complete surface map

- [ ] Confirm the running application, frontend/backend URLs, and available authenticated access.
- [ ] Capture before screenshots for all routes, tabs, dialogs, drawers, and representative states.
- [ ] Prepare isolated fixtures for populated, empty, loading, failed, stale, and read-only states.
- [ ] Include long titles, long model IDs, missing artwork, many chapters, and many providers.
- [ ] Record baseline typecheck/build results without overwriting mixed public assets.
- [ ] Inventory `frontend/public`, HTML metadata, manifest, icons, service worker, and font loading.
- [ ] Verify whether Remotion Studio and static preview pages are user-facing entry points; add their owned UI if applicable.

## Phase 1 — Foundations and application shell

Files: `frontend/src/index.css`, `frontend/src/components/layout/AppShell.tsx`, `frontend/src/components/ui/*`, and HTML entry files.

- [ ] Implement semantic color, typography, spacing, radius, elevation, and motion tokens.
- [ ] Replace duplicated presentation literals incrementally with scoped, shared styles.
- [ ] Redesign wordmark, sidebar groups, active navigation, counts, session identity, and role display.
- [ ] Redesign page heading/action layout and nested-view back navigation.
- [ ] Resolve mobile navigation, safe areas, long labels, and narrow-screen actions.
- [ ] Standardize buttons, icon buttons, links, badges, inputs, textareas, and password controls.
- [ ] Standardize field labels, help text, validation, disabled states, and save feedback.
- [ ] Review tabs, stepper, command/model picker, popovers, sliders, sortable lists, and dropzones.
- [ ] Standardize dialogs/drawers: sizing, scroll regions, sticky actions where useful, dismissal, and focus return.
- [ ] Standardize terminal/log views, audio previews, meters, copy feedback, and notifications.
- [ ] Add consistent loading, empty, retry, stale-data, and permission-state patterns.
- [ ] Verify keyboard focus, reduced motion, zoom, contrast, and touch targets before page rollout.

## Phase 2 — Library and series detail

File: `frontend/src/pages/LibraryPage.tsx`; routes `/`, `/#/series/:slug`.

- [ ] Library heading, search, sorting/filter controls present in the current UI, and primary create action.
- [ ] Continue-watching section: artwork, progress, chapter identity, resume action.
- [ ] Series collection: cover sizing, title wrapping, metadata, hover/focus, missing-cover fallback.
- [ ] Empty library, no search matches, loading, errors, and missing-series view.
- [ ] Series detail: artwork/title hierarchy, summary metadata, navigation, and production actions.
- [ ] Full compilation section: playback/download availability and file information.
- [ ] Chapter list: ordering, progress, alternate cuts, downloads, and privileged actions.
- [ ] Extend-series dialog: source, chapter options, validation, pending, success, and failure.
- [ ] Outro builder dialog: every configuration field, generation progress, outputs, and recovery.
- [ ] Delete-rendered-video dialog: exact target, scope, consequence, pending, and error states.

## Phase 3 — Playback and artwork

File: `frontend/src/pages/LibraryPage.tsx`; routes `/#/watch/:slug/:ch`, `/#/artwork`.

- [ ] Player layout, native video controls, aspect ratio, fullscreen, and mobile playback.
- [ ] Chapter heading, active cut/version controls, speed controls, file metadata, and download action.
- [ ] Chapter navigation, resume behavior, shortcuts, and visible shortcut help.
- [ ] End-of-video overlay: next chapter, replay, return to series, and focus management.
- [ ] Playback loading/error/retry and missing chapter/video states.
- [ ] Artwork page: gallery layout, filtering/selection where supported, labels, and empty states.
- [ ] Artwork lightbox: fit/contain behavior, metadata, download, close control, and keyboard access.

## Phase 4 — New series and production intake

File: `frontend/src/pages/NewSeriesPage.tsx`; route `/new-series.html` and its job/series query views.

- [ ] Wizard shell, step indicators, back/next actions, progress persistence, and focus placement.
- [ ] Source step: Drive URL, archive upload/dropzone, source checks, title/slug, and chapter selection.
- [ ] Voice and style step: provider/voice choice, narration settings, preview playback, and errors.
- [ ] Launch step: render lane choices, quality/options, review summary, and primary launch action.
- [ ] Upload/download progress and indeterminate progress when total size is unknown.
- [ ] Preparing-production, active-job detail, missing queried run, completion, and failed-job states.
- [ ] Active/recent run lists, stage indicators, details/logs, and available job actions.
- [ ] Duplicate-submit protection, interrupted requests, validation recovery, and read-only behavior.

## Phase 5 — Studio, one tab at a time

File: `frontend/src/pages/StudioPage.tsx`; route `/studio.html`.

User selected Studio as the first implementation phase. See [Studio delivery notes](design/studio/README.md) for screenshots, completed checks, and remaining live-service verification.

### Providers
- [x] Tab navigation, provider filters, connection summary, provider list, and empty state.
- [ ] Provider details: health, latency, models, capabilities, refresh/test actions, and removal confirmation.
- [x] Add/edit provider dialog: preset choice, endpoint, credentials, and conditional fields.
- [x] Cloud API, subscription, Vertex IAM, local server, and TTS variants (presentation; live authentication remains below).
- [ ] OAuth/device-code flows: browser handoff, copy code, waiting, expiration, cancellation, and failure.
- [ ] Vertex OAuth/service-account variants, file upload, validation, and connection tests.
- [ ] Model selection/search, custom model entries, and capability controls.

### Stage routing
- [x] Reader, Matcher, Writer, Scout, Fact check, and TTS sections.
- [ ] Primary/fallback model choices, model-picker popups, ordering, and concurrency/settings controls.
- [ ] Unsaved changes, save/reset feedback, conflicts, unavailable providers, and read-only state.
- [ ] Keyboard alternative to drag-and-drop ordering.

### Render nodes
- [x] Render-quality settings, storage summary, node list, health, slots, and resource metrics.
- [x] Add/edit node dialog for local, SSH, and cloud sandbox configurations.
- [ ] Connection testing, credential fields, validation, and save/error feedback.
- [ ] Node drawer: actions, terminal output, long logs, pending states, and stop confirmation.
- [ ] Enable/disable, priority/order, removal, and unavailable-node states.

### Voice
- [ ] Voice catalogue/selection, provider availability, preview text, and playback controls.
- [ ] Parameter sliders/steppers, current values, preview progress, and audio failures.

### Prompts
- [x] Reader, Visual Matcher, Story Writer, Writer, and Episode Outro navigation.
- [x] Prompt editor readability, long content, defaults/overrides, and contextual guidance.
- [ ] Save/reset/restore controls, unsaved changes, validation, and persistence feedback.

## Phase 6 — Pipeline monitoring

File: `frontend/src/pages/StatusPage.tsx`; route `/status.html`.

- [ ] Page heading, connection/freshness indicator, refresh, idle, stale, and error states.
- [ ] Live runs: active chapter/stage, elapsed time, progress, and actionable links.
- [ ] Worker/render-lane health, resource meters, capacity, and unavailable states.
- [ ] Chapter-stage matrix: row/column readability, stage detail, legend, and narrow-screen behavior.
- [ ] In-flight model calls and recent failures: useful ordering, detail, and recovery actions.
- [ ] Lane priority and slot summary plus expanded render-policy editor.
- [ ] Model-priority editor, ordering, enabled state, concurrency, save/cancel, and conflicts.
- [ ] Polling updates without disruptive layout shifts, focus loss, or excessive announcements.

## Phase 7 — Meter room

File: `frontend/src/pages/MeterPage.tsx`; route `/meter.html`.

- [ ] Header, source selection where available, refresh state, and last-updated information.
- [ ] Account quota display, pool labels, parked/active/idle states, and reset times.
- [ ] Usage-window tabs and token/call/failure summaries with clear units.
- [ ] Thirty-day chart: labels, gaps versus zero, accessible values, and responsive presentation.
- [ ] Breakdown table by meter/account/model, long names, and numeric alignment.
- [ ] Missing token data, unavailable endpoint, no accounts, and provider fallback views.
- [ ] Replace internal jargon in explanatory copy while preserving necessary diagnostic detail.

## Phase 8 — Storage and recovery

File: `frontend/src/components/shared/StorageTrashDrawer.tsx`; reachable from Library and Studio.

- [ ] Drawer hierarchy, disk summary, per-series usage, and per-chapter/artifact detail.
- [ ] Recoverable trash list, restoration controls, progress, and feedback.
- [ ] Move-to-trash, individual purge, and empty-trash flows with consistent consequences and confirmations.
- [ ] Explain temporary retention accurately; distinguish recoverable removal from permanent purge.
- [ ] Loading, failed requests, empty trash, stale totals, unavailable sizes, and read-only states.
- [ ] Verify both entry points and focus return to their respective triggers.

## Phase 9 — Login and setup

Files: `src/player/server.ts` (`LOGIN_PAGE`), `frontend/src/pages/SetupPage.tsx`.

- [ ] Login: product identity, concise copy, credentials, autofill, error state, session note, and mobile layout.
- [ ] Setup shell, four-step navigation, instructions, and progress feedback.
- [ ] Step 1: bootstrap token verification, visibility toggle, admin creation, validation, and errors.
- [ ] Step 2: first provider, every auth variant, model choices, tests, and retry flows.
- [ ] Step 3: optional render lanes, local readiness, SSH/cloud configuration, and connection tests.
- [ ] Step 4: readiness summary, finish/launch actions, pending state, and completion errors.
- [ ] Setup already completed, unavailable bootstrap, and return-navigation behavior.
- [ ] Match login/setup typography and controls to the authenticated application.

## Phase 10 — Production acceptance

Apply these gates to every phase, then run the complete cross-page pass.

- [ ] Capture and critique desktop (1440px), tablet (768px), and mobile (390px) screenshots; also test 320px reflow.
- [ ] Test short viewports, virtual keyboards, 200% zoom, long content, and nested scroll regions.
- [ ] Verify WCAG AA text contrast, non-text control contrast, visible focus, labels, and sensible headings.
- [ ] Test keyboard-only navigation, tab behavior, dialog focus trap/return, Escape, and screen-reader announcements.
- [ ] Verify reduced-motion behavior and at least 44px primary touch targets.
- [ ] Exercise populated/empty/loading/error/stale/read-only states for every applicable surface.
- [ ] Exercise back/forward navigation, refresh on nested routes, and supported path/hash aliases.
- [ ] Verify actual save, upload, preview, playback, download, retry, and recovery flows in isolated test data.
- [ ] Check Chromium, Firefox, and WebKit behavior, especially video, dialogs, and mobile layout.
- [ ] Check image sizing/lazy loading, fonts, layout shifts, route load cost, and polling responsiveness.
- [ ] Run `npm --prefix frontend run typecheck` and applicable behavioral tests.
- [ ] Run the frontend production build only after resolving public asset ownership; verify built routes and assets.
- [ ] Check manifest/icons/theme color, service-worker updates, and stale-cache recovery.
- [ ] Confirm no unexplained console errors, broken requests, clipped controls, or placeholder content.
- [ ] Record after screenshots and close each defect before marking its phase complete.

## Delivery log

| Phase | Status | Evidence / next action |
| --- | --- | --- |
| Source audit and plan | Complete | Source findings and full worklist recorded here |
| Visual baseline | Partial | Studio reviewed in Chromium using isolated API fixtures; authenticated production audit remains |
| Design direction | In progress | Production-desk direction applied to Studio; artwork-led library remains queued |
| Studio implementation | Complete | Five tabs, responsive overlays, scoped theme, draft-preserving navigation; see delivery notes |
| Other pages | Pending | Continue the checklist one page at a time |

Per-phase completion record: date; changed files; routes/states checked; screenshot paths; commands and results; remaining defects; review decision.
