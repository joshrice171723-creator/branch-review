# Learn verification

## Job 1 — Branch push

GitHub confirmed the initial Learn branch at a44d7c2c9fe7210e68216d4c0490c8ab46460fb2 on codex/learn-walkthrough. The push updated only that branch.

## Job 2 — Live Muse Tutor

**PASS.** Tested in the desktop app with DefenseLoop Section 2 at reminder_runner.rb:4. The first attempt answered both turns but left out the refresh ordering in Q1. The retry used a fresh session and distinguished setup from the ordering of the work.

The retry identifies due batches at line 8 before the PMS refresh at line 11. Both turns returned in the same saved Muse session. The second prompt carried the question and cue location with no source text. Microsoft David (English, United States) emitted speech start and end events for both three-sentence answers.

### Q1

In plain English, what does tick do first?

**DISPLAY**

Setup comes first: `tick` at line 4 sets `failed = false` at line 5, opens the database at line 6, and collects due batches at line 8. Its first main operation is line 11, `db.transaction { flow.import_snapshot }`, which happens before the clinic loop at line 18.

**SAY**

First it gets ready by opening the database and collecting the batches that are due. Then its first main job is importing the snapshot. That happens before it starts looping through the clinics.

Muse response time 19.22 seconds.

### Q2

Why does that order matter?

**DISPLAY**

The import at line 11 must finish before the clinic loop at line 18, because the loop checks `if refreshed && batches.key?(id)` at line 22. If the import hits the `Conflict` error handled at lines 12 to 15, `refreshed` becomes false and line 25 runs the clinic work with reminders turned off instead.

**SAY**

The import has to happen first because the clinic work checks whether it succeeded. If it failed, the code takes the path that does the work without sending reminders. If it happened afterwards, clinics could send reminders without knowing the refresh had failed.

Muse response time 17.89 seconds.

### Earlier fixture timeout

The earlier synthetic request reached the 60-second deadline without a completed answer. Muse export reported no retained session for that fixture workspace, so the historical cause could not be recovered. The installed Muse CLI usage check returned server_sent_no_usage, which the existing provider treats as unverified. No live turn returned a sign-in or no-allowance error. A fresh seven-line synthetic request through the same PLAN runner completed in 12.50 seconds. The app uses that same runner and shares its 60-second deadline.

## Job 3 — Teach me this branch

**BLOCKED before authoring.** The desktop opened the approved and published Meta Clinic review for codex/sandbox-button-blue-once from Saved reviews. The sheet showed the exact base 505d00ab90356f66f2ba67bd6a40b379a2889d69 and head fe376395ff3d499451d52309b6cbcc8561960868. The diff has two files with text changes.

- .branch-review.json
- apps/web/src/features/marketing/MetaClinicMarketing.tsx

Automatic approval review required explicit authorization to send those pinned Meta Clinic excerpts and diff to the signed-in Codex CLI. The app did not submit a provider request, so no steps, cues, playback, code comparison, or ZIP were produced.

## Job 4 — Standalone retirement

**SKIPPED.** Job 3 did not pass. The standalone player remains as the fallback. This job performed no salvage, deletion, or seven-section playback check.

## Repository checks

The before and after npm test runs each passed 198 of 202 tests. Both reported the same three pre-existing review UI failures and the Claude fixture timeout. The configured-check timing test passed both runs.

The protected appointment-flow checkout still reported only its pre-existing README.md modification and untracked .idea directory. The DefenseLoop file listing matched the baseline. The paid API domain check returned zero hits.
The focused rerun passed all 30 tests, including both timing-sensitive checks.
