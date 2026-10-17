# 0.5.0 project workflow acceptance

Implemented project selection/diagnostics, generic Vite/Next previews and custom runtime recipes, diff-derived navigation, Codex fixes with host-owned commit finalization, default-branch delivery and optional GitHub PR/custom deployment, observable desktop browser checks and evidence.

2026-10-17 Windows desktop pilot: separate two-page Vite Git repository. Real Codex generated two route-specific items. Original and Changed showed rust versus blue/purple. Reported purple tutorials button, dispatched real Codex, and produced clean fix commit 63c692943064fe9f8ebe0d57ebaaae29b2b6b51b changing only tutorials.js. The grouped review opened /tutorials ready to retest, with purple Before fix and blue After fix. Browser run 3ef4a530-e828-4f21-bb92-70a2d7ca7eb1 passed four real actions: visit, computed blue background, click, and resulting Sandbox opened text, saving four screenshots. No manual check was automatically passed.

CLI configuration failure was reproduced and corrected; connector disabling was verified with the real CLI. No global Codex settings changed. Custom-preview tests run actual isolated HTTP processes. Deployment tests use controlled receipts and disposable local Git remotes; no live project was deployed by this acceptance run.

Boundaries: custom stacks require configured runtime commands/services/data isolation. Native/mobile UI requires a harness. Generic browser actions are explicit assertions, not autonomous QA discovery; generic hosted QA is not wired to the local runner. Real hosted deployment/PR acceptance and live Claude remain unverified. Packaging is unsigned Windows x64.

---

# Branch Review delivery

## First 22 items — local delivery complete

The guided review, six-item Meta Clinic QA pilot, isolated intake, findings, evidence reports,
comparison tools, integration candidate and delivery controls are implemented.
41 automated tests passed at cf5eeab. Native desktop evidence is in ../desktop-verification.
The remaining screenshot enlargement and unresolved-finding filter were verified on October 15.
The packaged desktop source matches cf5eeab. No live Meta Clinic merge or publish was executed.
Publishing is implemented but its live deployment path remains unverified.

## Next 20 — implemented in 0.4.0

1. Codex-generated branch plans
2. Fix-only review navigation
3. Updated-branch detection and retest
4. Targeted retest recommendations
5. Direct Codex fix-and-return integration
6. Versioned in-app plan editor
7. Capture current screen as an item
8. Restore reproducible scenario data
9. Record and replay supported interactions
10. Visual comparison with ignore regions
11. Screenshot annotations
12. Short defect recordings
13. Redacted error and request evidence
14. Configured automated checks
15. Per-screen accessibility checks
16. Responsive presets and separate checks
17. Repeatable performance comparison
18. Reuse and prepare preview environments
19. Branch dependency and overlap analysis
20. Guided post-publish verification

All twenty controls and their local persistence/integration paths are implemented. The consolidated
suite passed 53 tests; a subsequent configured-check execution regression passed with the other
11 tool tests (54 tests total). A focused gateway regression also verifies forwarding to a promoted
spare runtime instead of the default port.

Native desktop checks verified the versioned plan editor (six items became eight, with 16 unchecked
requirements and previous evidence retained), current-screen accessibility analysis, matching
Original/Changed screenshot capture and pixel highlighting, and a background preview preparation
job completing with its own database and servers while the active pair remained available.
Reopening promoted the spare runtime (3430/3431) to Changed, and the live QA check passed exact
commit and row assertions through the normal gateways. Native recording produced a playable
15-second preview clip. The queue remains visible in the 1200px-wide desktop window.
Evidence: ../desktop-verification/visual-comparison-0.4.png.

The remaining native acceptance work is recorded below. Live publishing remains outside the local test run.


## 0.4.1 — UI cleanup and real fix handoff

The main screen now prioritizes the preview, active instructions, checks, notes and Previous/Next.
Comparison controls, branch metadata and advanced tools are collapsed. Findings use a dedicated
dialog; delivery controls live in results. Screenshot thumbnails and Codex output stay compact.

Native desktop acceptance on October 15:

- Real Codex dispatch found the installed Windows CLI without relying on terminal PATH.
- A dedicated fix chat received the reviewed request, manifest, commits and evidence paths.
- The Codex sandbox could write the fix but could not update the shared Git index. The app's
  explicit selected-file commit flow committed only `.branch-review.json` as `efb7649`.
  An unrelated tooling edit in AGENTS.md remained uncommitted in the isolated fix checkout.
- Review fixed branch reopened Original `ecbe9d9` against Changed `efb7649`; eight items and
  sixteen checks started unchecked. Two unresolved findings, their notes, PNG and WebM evidence
  carried forward. Retest notes resolved both findings.
- The exact-build QA check passed 116-row coverage, saved-result precedence and stale-result control.
- Box/arrow screenshot annotations and a 15-second clip attached to a finding. The saved clip
  played to completion after restart and survived return on the fixed branch.
- Phone (390px) and tablet (768px) items opened the correct QA rows in both versions.
- A recorded form edit replayed into Original. The form was not submitted, then Reset item
  returned both previews to coverage.
- The configured apps/web TypeScript check ran from the desktop against the isolated Changed
  checkout and succeeded. Three-load performance measurements persisted for both versions.

- Cropped tablet captures exclude review chrome; a timestamp ignore region was applied and saved.
- Restore starting data completed in Changed, reset review checks and preserved evidence. The
  exact-build QA check passed again after the reset. Hosted verification stayed disabled.

59 automated tests pass, including clean-commit handoff validation, selected-file preservation,
review identity carry-forward and capture clipping for horizontally scrolled previews.
Evidence and the portable report are in ../desktop-verification.

No live Meta Clinic push or publication was performed. Hosted post-publish acceptance remains
unverified. Read-only Codex plan generation succeeded and opened a six-item draft without replacing the
saved eight-item review. Capture-current-screen, reorder and removal worked in the draft editor.
Resumed-chat dispatch has boundary tests; the real handoff acceptance used a new dedicated chat.

## 0.4.2 — isolate generated plans

Plan generation now creates a detached checkout at the exact reviewed commit. Codex and its indexing tools run there, away from both active previews. The checkout is retained for diagnosis. A regression deliberately edits AGENTS.md in that checkout and verifies the active preview content, HEAD and Git index remain unchanged. All 60 automated tests pass. Packaged desktop acceptance is pending.

## 0.4.3 — interview demo destinations

Guided plans now support the public homepage, /meta-clinic and /demo without forcing a development login. The same destination boundary validates plans, preview routing and published desktop links. Open Office checks the exact published revision before opening the hosted workflow grid.

All 62 automated tests pass and the Windows package builds. Native desktop acceptance compares main f0a0e74 with Meta Clinic demo db234c81: Original has the rust hero button; Changed has the purple hero button. The toggle retains the same screen, keyboard focus is visible, Enter opens sandbox account selection, Reset item returns home, and Next preserves unfinished checks. Screenshots are in ../desktop-verification/interview-*.png. The initial native test found a shared marketing CSS override; the demo branch fixes it and corrects the original-color instructions.

Muse's two existing tunnels were restored after Joshua directly re-enabled them. Both connectors respond, a fresh authenticated Office check-in advanced revision 454 to 455, and the exact-build inbox exchange returned Muse's acknowledgment at 2026-10-16T02:57:30Z. This was connection/handoff evidence, not a QA verdict. The activation gap is addressed by 0.4.4 below.

## 0.4.4 — automatic post-publish Muse QA

Successful publication now persists a pending exact-build Office assignment before dispatch, submits it through the publisher's existing SSH key and the server's `Qa::OfficeWork` service, and opens Office automatically. No new token, password or Muse credential is required. The server-bound owner principal creates the task; Muse independently verifies requester and live revision before work. A failed handoff does not turn a successful deployment into a failed release. Pending submissions recover after app restart and retry up to three times with an unchanged release key and payload; a separate retry never republishes. Office task receipts drive the displayed QA state.

Muse's `publish-qa-wake` hook is enabled and checks for new queued `branch-review-publish-*` tasks every 60 seconds. It baselines existing work and deduplicates release keys. This is a publish-event watcher, not recurring QA; the worker runs one bounded pass, sends authenticated Office check-ins while working, records real workflow evidence, then stops. The hook depends on Muse's host and existing adapter remaining available.

Actual automatic-wake verification on the already-live `89a7692e516b0a2a03a237760fdf23b5d2be71b8`: Office task 9 submitted at 2026-10-16T03:28:20Z, acknowledged by Muse at 03:28:55Z, working at 03:29:19Z, completed at 03:29:25Z. No chat message activated Muse after submission. Muse recorded authenticated check-in revision 456, exact build match and `/up` HTTP 200. Replaying the identical submission returned completed task 9. This was explicitly a read-only transport test, with no browser QA or workflow pass verdicts. Evidence: `../desktop-verification/automatic-muse-wake.json`.

21 focused regression tests passed, covering exact-build rejection, duplicate submission, lost-response reconciliation, restart recovery, publish-success ordering and automatic Office opening. Windows package 0.4.4 rebuilt. The actual purple-button release and its live pulsing activity indicator remain pending Joshua's review and publication.
