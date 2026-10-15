# Branch Review

A Windows desktop app for reviewing local Git branches. Meta Clinic is the first supported preview adapter.

## Open

Run `../desktop/Branch Review-win32-x64/Branch Review.exe`. Keep the executable with the rest of that folder. The pilot restores the running preview pair and its saved review. This is a local unsigned build; Meta Clinic's development prerequisites remain required.

From source:

```powershell
npm ci
node node_modules/electron/install.js
npm run desktop
```

`npm run package:desktop` builds the Windows executable. `npm start` provides the browser interface at http://127.0.0.1:4310 instead; close that server before opening the desktop app. Only one controller can own the fixed ports.

**Open repository** selects a local Git folder. Branch listing works with Git repositories; previews and publishing currently support Meta Clinic. The branch list defaults to **Unmerged into main**, based on commit ancestry against origin/main. Identical local/remote copies are combined; divergent copies remain separate. **All branches, including merged** shows historical work. The local branch list refreshes automatically every 30 seconds. Use Refresh to fetch current remote refs. The All/Unmerged filter survives reopening. This is merge status, not a claim that a revision has been published. Search a branch, choose Previous commit or Common ancestor with main, then **Open review**. First setup installs dependencies and migrates a separate database for each revision.

Original and Changed stay mounted while toggling. Choose **Side by side** to see both, adjust the split, or disable **Link scrolling** for independent inspection. Linked tables align by the first visible row's first-cell identifier when unique in the matching table; otherwise comparison uses pixel position. Re-enabling the link aligns the other preview immediately. Preview forms and data remain isolated. **Reset item** returns both to the selected screen; save preview edits first. Stop previews stops the owned stacks and preserves databases. Closing the desktop app keeps previews running and is blocked during active operations. Window size and maximized state are restored.

## Guided QA

1. Choose a branch. Its description, exact comparison, changed files and review plan appear before startup. Compare against the previous commit, common ancestor, current main, or a chosen commit from history.
2. **Open review** starts two isolated versions and opens item 1. The left queue shows progress; the right panel explains what changed, what to do, and the expected result. Hide branches to give the queue more room.
3. Check each observed result and add notes. Notes autosave and recover after reopening. A failed save blocks navigation instead of silently losing your work.
4. Use **Next item** / **Previous**, or select any queue item. Next skips completed items. Leaving an unfinished item requires an explicit choice and never marks it passed. Use search and Remaining / Needs attention / Completed filters for a long review.
5. A failed or blocked item needs a reason. **Not applicable** also requires a reason and remains visible as an exclusion in the summary. Open findings override a passing checklist.
6. The results screen shows every outcome and the next valid delivery action. **Prepare fixes for Codex** creates a scoped request with exact revisions, failed or unverified items, notes and findings. Copy or download it into the branch's Codex chat; this version does not send messages automatically.

Items sharing a screen preserve its state and focus the relevant row or heading. The toolbar reports when the target is located, missing, or cancelled by manual navigation. Target discovery waits up to one minute for slower screens; scrolling or navigating yourself cancels the pending jump. Moving to another screen prompts before discarding unsaved preview edits. Alt+Left / Alt+Right navigate items; Alt+V toggles versions, including when the preview has focus. These shortcuts do not intercept typing in fields. **Review code** always shows the active review's pinned revisions, even when a different branch is selected in the browser.

## Local configuration

The pilot repository is `C:/Users/joshr/Desktop/meta_clinic`. `.local/config.json` accepts `repository`, `previewRoot`, and `toolchain` (the directory containing pinned pnpm.cmd). The desktop app stores its selected data directory in its user-data `desktop.json`. `BRANCH_REVIEW_HOME` overrides the data directory; `META_CLINIC_REPO` overrides the repository. Configuration, screenshots and review records are never committed.

This workspace uses `../../work/previews` and `../../work/toolchain/node_modules/.bin`. The private package manager can be prepared with:

```powershell
npm install --prefix ../../work/toolchain pnpm@11.19.0 --no-audit --no-fund
```

Meta Clinic also needs its pinned Ruby, Node, PostgreSQL client tools, Python and Docker prerequisites. Choose a new nonexistent previewRoot for a new installation. The app writes an ownership marker and refuses unrelated directories. It never switches the primary checkout or discards worktree edits.

| Resource | Original | Changed |
| --- | --- | --- |
| Gateway | 4311 | 4312 |
| Web | 3410 | 3420 |
| API | 3411 | 3421 |
| PostgreSQL | 54541 | 54542 |
| Container | apply-review-original | apply-review-changed |

Listeners use loopback. Database names include side and revision; an older revision never migrates a newer revision's database backwards. Gateways namespace cookies by side and revision. Preview origins have separate browser storage. Control requests require the workspace origin and a per-process token. The Electron renderer is sandboxed with context isolation and no Node integration; only the main review frame can request the narrow desktop actions.

Setup/start/stop use Meta Clinic's lifecycle through its shared resource queue. Worktree edits block switching. Diagnostic files are stored in the local data directory. Databases and worktrees are retained for reuse.

## Saved reviews

1. Open a branch, compare versions, and complete each review item.
2. Record expected and actual behavior. Capture screenshot attaches the desktop window. Findings also include the side, revision, scenario, current route and captured browser errors. These are local records, not GitHub issues.
3. Saved reviews can reopen the latest branch commit for retesting. Unresolved findings carry forward; new revisions reset checks and approval. Resolving a finding requires a retest note.
4. Approval binds the source, baseline, candidate, manifest and seed recipe. Checklist or finding edits invalidate approval.

Findings can be filtered by current item or unresolved status. Click a screenshot to enlarge it with its original revision and route. Retest notes survive filtering and rerenders. **View / export review report** produces a portable HTML report with checks, outcomes, notes, findings, embedded screenshots, approval and delivery history. Saved reviews remain inspectable after moving to a new commit.

Records are in `reviews.json`; images are under `screenshots/` in the configured local directory.

## Merge and publish

Prepare integration candidate fetches current main and constructs the merge result without switching the primary checkout. Original becomes main, Changed becomes the candidate. Conflicts stop preparation. Test and approve this exact result before Merge and push to main. Source or main changes block shipping; pushes are ordinary fast-forward pushes, never force pushes. An uncertain push can be retried to reconcile the remote revision.

Publish settings selects the existing SSH key and encrypted recovery directory. Publish separately confirms the exact commit and https://aimetaclinic.com. It invokes Meta Clinic's existing `ops/lightsail/release.ps1` from a dedicated clean clone on main, using its backup, migration and release checks. Publishing is restricted to the Meta Clinic origin. Failed/interrupted deployment requires an inspection note before retrying; do not blindly remove recovery artifacts.

The app checks hosted build identity and health before recording Published. Test the hosted workflow yourself and record its result to mark Verified. Push, deployment and workflow acceptance are separate states.

The pilot branch `codex/intake-completion-ui` compares `8968d0b8` with `a4948139`. It is already included in main and is blocked from merging again. These older revisions lack readable build metadata: comparison still works, but approval health remains blocked with an explanation.

## Explicit scenario manifest

Add `.branch-review.json` to a branch to name affected routes and checks. It is read from the exact committed candidate and validated before preview preparation. Without a manifest, changes to `apps/api/app/services/qa/office_qa.rb` use the six-item QA coverage plan; other branches use a clearly labeled starter intake plan. This is explicit mapping, not general impact discovery. Confirm the starter checks cover the actual change before approval.

Versions 1 and 2 support 1–100 review items, each with 1–20 checks. The JSON file is limited to 64 KB. Paths stay under `/clinic` or the `/qa` page. `:intake` uses the seeded encounter; `:patientId` and `:encounterId` interpolate its identifiers. `originalPath` optionally provides a different destination for Original. `focus` matches a table row's first-cell identifier or an exact heading label. Keep item IDs stable across fixes so unresolved findings carry forward correctly. The manifest guides navigation and testing; it does not execute scripts or create arbitrary seed data.

```json
{
  "version": 2,
  "title": "Intake controls",
  "summary": "Answer controls make incomplete intake questions easier to find.",
  "scenarios": [{
    "id": "intake",
    "title": "Partially completed intake",
    "path": ":intake",
    "description": "Review the changed answer controls on a partly completed intake.",
    "instructions": "Compare both versions, then edit an answer in Changed and reopen it.",
    "expected": "The answer persists in Changed while Original remains unchanged.",
    "steps": ["Save an answer in Changed", "Confirm Original stays unchanged"]
  }]
}
```

## Validation

```powershell
npm test
npm run test:live
node test/qa-live.mjs
```

Unit tests cover Git comparisons, invalid refs, session separation, gateway boundaries, persisted findings, approval invalidation, merge candidates, moving refs and simulated release results. Delivery tests push only to disposable local bare repositories. Release tests never contact the hosted application.

The intake live check requires a ready intake preview pair. It signs into both with one cookie jar, saves and reloads a synthetic answer in Changed, verifies Original stays unchanged, then restores the answer. The QA live check requires the QA pair; it validates exact build IDs and the saved-result projection. Run the check matching the active plan.

Windows Computer Use verified the six-item QA journey, all 12 checks, persisted notes, Previous/Next, unfinished-item handling, blocked-item reasons, result summaries, fix-request preparation, screenshot capture, finding resolution, portable report display, source diffs, side-by-side views, linked scrolling, keyboard controls and restoring the correct route on 2026-10-15. Original ecbe9d9 shows historical untested rows; Changed 3f9a686 shows WF-011 Fail and WF-012 Pass, while WF-013 remains stale. Native Windows automation provides desktop acceptance; the browser-only connector cannot control this app. The local integration candidate `16c047d` against main `f0a0e74` also passed all 12 guided checks and exact-build live verification. Its approval was saved; the merge confirmation was inspected and cancelled. The intake journey saved a Changed answer through the desktop, preserved Original, and retained the answer after a full restart. Live publication remains untested. This implementation task has not pushed or deployed Meta Clinic changes.

## QA grid comparison

`codex/qa-grid-freshness` uses the parent commit as Original and the branch tip as Changed. Both receive the same synthetic post-import snapshot: 116 historical workflow rows plus saved result records for WF-011 (Fail), WF-012 (Pass), and WF-013 (an older-build Fail). Original shows the imported historical rows; Changed projects saved results over them, keeping WF-013 stale. These fixtures test the read projection, not cryptographic receipt submission or live QA outcomes. No hosted ledger is modified.

`node test/qa-live.mjs` checks the ready pair's exact build IDs, QA route, original/changed rows, stale-build control, and repeated reads. It writes `.local/qa-verification.json`. Desktop previews automatically use the scenario selected from the changed files. Windows stop recovery removes only PID records whose processes no longer exist and whose root and role match the owned checkout; live or unrelated records remain untouched.

Windows Computer Use verified bidirectional scroll alignment on 2026-10-15: Changed to Original retained WF-010–014; scrolling Original and switching back retained WF-012–016. Regression tests cover different row heights, horizontal scrolling, missing-row fallback, message boundaries and feedback suppression.
