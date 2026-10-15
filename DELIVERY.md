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

Verification limits: the configured Codex CLI was detected, but no generation request or direct
chat fix job was sent. No live Meta Clinic push, publication or hosted checklist was performed.
Recording/replay, annotations, clip attachment, responsive presets and performance sampling
have automated boundary coverage where applicable but do not yet all have complete
native desktop journey evidence. Implementation completion is not full end-to-end acceptance.
