# Branch Review

A Windows desktop app for reviewing local Git branches. Meta Clinic is the first supported preview adapter.

## Open

Run `../desktop/Branch Review-win32-x64/Branch Review.exe`. Keep the executable with the rest of that folder. The current pilot uses the saved configuration for this workspace and restores the running intake previews. This is a local unsigned build; Meta Clinic's development prerequisites remain required.

From source:

```powershell
npm ci
node node_modules/electron/install.js
npm run desktop
```

`npm run package:desktop` builds the Windows executable. `npm start` provides the browser interface at http://127.0.0.1:4310 instead; close that server before opening the desktop app. Only one controller can own the fixed ports.

**Open repository** selects a local Git folder. Branch listing works with Git repositories; previews and publishing currently support Meta Clinic. The branch list defaults to **Unmerged into main**, based on commit ancestry against origin/main. Identical local/remote copies are combined; divergent copies remain separate. **All branches, including merged** shows historical work. Use Refresh to fetch current remote refs. This is merge status, not a claim that a revision has been published. Search a branch, choose Previous commit or Common ancestor with main, then **Open review**. First setup installs dependencies and migrates a separate database for each revision.

Original and Changed stay mounted while toggling. Preview data is isolated, but desktop validation observed scroll positions resetting on a toggle. Reopen returns both to the saved scenario; save edits first. Stop previews stops the owned stacks and preserves databases. Closing the desktop app keeps previews running and is blocked during active operations.

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

1. Open a branch, compare versions, and complete each scenario check.
2. Record expected and actual behavior. Capture screenshot attaches the desktop window. Findings also include the side, revision, scenario, current route and captured browser errors. These are local records, not GitHub issues.
3. Saved reviews can reopen the latest branch commit for retesting. Unresolved findings carry forward; new revisions reset checks and approval. Resolving a finding requires a retest note.
4. Approval binds the source, baseline, candidate, manifest and seed recipe. Checklist or finding edits invalidate approval.

Records are in `reviews.json`; images are under `screenshots/` in the configured local directory.

## Merge and publish

Prepare integration candidate fetches current main and constructs the merge result without switching the primary checkout. Original becomes main, Changed becomes the candidate. Conflicts stop preparation. Test and approve this exact result before Merge and push to main. Source or main changes block shipping; pushes are ordinary fast-forward pushes, never force pushes. An uncertain push can be retried to reconcile the remote revision.

Publish settings selects the existing SSH key and encrypted recovery directory. Publish separately confirms the exact commit and https://aimetaclinic.com. It invokes Meta Clinic's existing `ops/lightsail/release.ps1` from a dedicated clean clone on main, using its backup, migration and release checks. Publishing is restricted to the Meta Clinic origin. Failed/interrupted deployment requires an inspection note before retrying; do not blindly remove recovery artifacts.

The app checks hosted build identity and health before recording Published. Test the hosted workflow yourself and record its result to mark Verified. Push, deployment and workflow acceptance are separate states.

The pilot branch `codex/intake-completion-ui` compares `8968d0b8` with `a4948139`. It is already included in main and is blocked from merging again.

## Explicit scenario manifest

Add `.branch-review.json` to a branch to name affected routes and checks. It is read from the committed candidate. Without a manifest, changes to `apps/api/app/services/qa/office_qa.rb` open the QA coverage scenario at `/qa?view=coverage`; other branches use the intake scenario. This is explicit file-to-scenario mapping, not general impact discovery. Up to 12 scenarios with 20 steps each are supported. Paths stay under `/clinic` or the `/qa` page. `:intake` uses the seeded encounter; `:patientId` and `:encounterId` interpolate its identifiers.

```json
{
  "version": 1,
  "title": "Intake controls",
  "scenarios": [{
    "id": "intake",
    "title": "Partially completed intake",
    "path": ":intake",
    "steps": ["Save an answer in Changed", "Confirm Original stays unchanged"]
  }]
}
```

## Validation

```powershell
npm test
npm run test:live
```

Unit tests cover Git comparisons, invalid refs, session separation, gateway boundaries, persisted findings, approval invalidation, merge candidates, moving refs and simulated release results. Delivery tests push only to disposable local bare repositories. Release tests never contact the hosted application.

The live check requires a ready preview pair. It signs into both with one cookie jar, saves and reloads a synthetic answer in Changed, verifies Original stays unchanged, then restores the answer.

The Windows build launches and restores the pinned preview pair. Unit tests and the live persistence/isolation check pass. Windows Computer Use visually verified Original/Changed switching and Reopen scenario on 2026-10-15. Both sides show Workflow coverage at /qa?view=coverage: Original ecbe9d9 shows historical untested rows; Changed 3f9a686 shows WF-011 Fail and WF-012 Pass, while WF-013 remains stale. The original UI-control connector remains unavailable; native Windows automation provided this acceptance. The in-app screenshot action, folder picker and complete release click-through remain unverified. This implementation task has not merged or deployed Meta Clinic changes.

## QA grid comparison

`codex/qa-grid-freshness` uses the parent commit as Original and the branch tip as Changed. Both receive the same synthetic post-import snapshot: 116 historical workflow rows plus saved result records for WF-011 (Fail), WF-012 (Pass), and WF-013 (an older-build Fail). Original shows the imported historical rows; Changed projects saved results over them, keeping WF-013 stale. These fixtures test the read projection, not cryptographic receipt submission or live QA outcomes. No hosted ledger is modified.

`node test/qa-live.mjs` checks the ready pair's exact build IDs, QA route, original/changed rows, stale-build control, and repeated reads. It writes `.local/qa-verification.json`. Desktop previews automatically use the scenario selected from the changed files. Windows stop recovery removes only PID records whose processes no longer exist and whose root and role match the owned checkout; live or unrelated records remain untouched.
