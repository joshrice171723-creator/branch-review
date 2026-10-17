# First-run setup audit and desktop acceptance

Date: 2026-10-17. Scope: first-run setup and an unrelated project, preserving Meta Clinic. This is not clean-machine or all-project certification.

## Reused rather than rebuilt

| Capability | Existing evidence | Result |
| --- | --- | --- |
| Project selection and separate storage | `desktop/main.cjs`, per-project config and review homes | Retained; removed previous project's toolchain inheritance |
| Codex discovery and sign-in checks | Provider probe used by existing Settings | Reused in the setup guide |
| Automatic npm Vite/Next previews | `web-project.mjs` and existing preview lifecycle | Reused; exercised with a separate Vite project |
| Other project types | Existing custom preview command editor and recipes | Retained; not newly desktop-tested for every stack |
| Generated checklists | Existing isolated diff-plan generation | Real Codex generation succeeded for the new project |
| Original/Changed and project recovery | Existing isolated worktrees, review storage and routing | Desktop-tested; Meta Clinic restored afterward |

## Missing pieces completed

- First-run guide checks Git, repository, origin, default branch, commit identity, preview setup and Codex.
- Failed checks explain the next action. Start reviewing is unavailable until checks pass; the server rechecks before saving completion.
- Check again recovers after prerequisites are repaired. Successful setup clears the stale startup error.
- Completion is saved per project. Existing review workspaces are not interrupted, and Settings can reopen the guide.
- Invalid repository selection offers another folder or cancellation instead of throwing out of startup or switching away from the current project.
- Guide buttons match the app, and all checks/actions fit in the tested 1201 × 993 desktop window.

## Evidence

Fresh local Field Notes Vite project, with its own state directory and disposable bare Git remote:

1. Launched the packaged desktop app into fresh project storage.
2. Removed origin deliberately. Remote/default-branch checks failed with actionable text; Start reviewing stayed disabled.
3. Restored origin and its default branch. Check again enabled Start reviewing; completion was saved.
4. Opened `feature/green-button`. The existing runtime installed locked dependencies and launched both previews. Codex generated a checklist describing the actual CSS change and `/` destination.
5. Changed showed the green Add a note button at `7b3cf0c`; clicking it displayed “Your note is ready.” Original showed the blue button at `7cc7b02`.
6. Repackaged with the final layout adjustment, reopened the project, and verified setup did not interrupt it again. Reopened the guide from Settings and verified its complete layout.
7. Switched back through the desktop picker to Meta Clinic. Its existing blue After fix preview at `eac50e2` reopened on `/meta-clinic/platform`, with item 3 of 4 selected. Config values matched the pre-test backup; `review.json` matched its pre-test SHA-256 exactly.

Automated checks: the full suite passed 112 tests before the final guide adjustment. The focused final setup/UI suite passed 3 tests, including one newly added test (113 distinct tests in total). Syntax and diff checks passed; desktop packaging succeeded. The invalid-folder retry/cancel path has unit coverage, not a native invalid-folder walkthrough in this run.

No project changes were merged or published. The test project remains available locally for repeat testing.

## Remaining turnkey gates

- Clean Windows-machine install and missing-runtime recovery beyond this configured host.
- Signed installer and update distribution.
- Additional real project stacks, service dependencies and authentication recipes.
- Live Claude validation remains deferred at the user's request.
- No new fix-to-publish or hosted QA acceptance is claimed by this setup test.
