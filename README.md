# Branch Review

A separate local app for reviewing Meta Clinic branches in two interactive, isolated previews.

## Run

```powershell
node server.mjs
```

Open <http://127.0.0.1:4310>. The review app itself has no package dependencies. Meta Clinic previews need its pinned Ruby, Node, pnpm, PostgreSQL client tools, Python, and Docker prerequisites.

Search the branch list, choose a baseline, and select **Open review**. **Original** and **Changed** remain mounted while toggling, so each retains its own form and scroll state. **Reopen intake** signs into the seeded staff account and returns both versions to Jordan Review's encounter; save first. **Stop previews** stops only the owned Meta Clinic stacks and preserves their databases.

The first pilot uses `codex/intake-completion-ui` and **Previous commit**: `8968d0b8` versus `a4948139`. It compares the real structured-intake control change. The intake scenario is available for other compatible branches, but automatic impact discovery is not implemented; a branch changing billing still opens the explicit intake scenario.

## Local configuration

Defaults target `C:/Users/joshr/Desktop/meta_clinic`. Optional `.local/config.json` accepts `repository`, `previewRoot`, and `toolchain` (directory containing the pinned `pnpm.cmd`). `META_CLINIC_REPO` is an alternative when no repository override is configured. Never commit local configuration or runtime records.

The current workspace keeps previews under `../../work/previews` and pnpm 11.19.0 under `../../work/toolchain/node_modules/.bin`. To prepare that private package manager on a fresh workspace:

```powershell
npm install --prefix ../../work/toolchain pnpm@11.19.0 --no-audit --no-fund
```

Choose a new, nonexistent previewRoot for a new installation. The app creates an ownership marker there and refuses to adopt unrelated existing directories. Repository worktrees and databases are created on demand; the developer's primary checkout is never switched or merged.

| Resource        | Original              | Changed              |
| --------------- | --------------------- | -------------------- |
| Preview gateway | 4311                  | 4312                 |
| Meta Clinic web | 3410                  | 3420                 |
| Meta Clinic API | 3411                  | 3421                 |
| PostgreSQL port | 54541                 | 54542                |
| Container       | apply-review-original | apply-review-changed |

All listeners use loopback. Database names include side and commit, so older revisions never migrate a newer revision's database backwards. Worktree-local files and browser local storage are independent. Gateways namespace and filter cookies by side and revision, including older Meta Clinic versions with a shared cookie name. Preview pages can only be framed by the review app. Mutating control requests require the app's origin and a per-process token.

Only one preview operation can run at a time. Setup/start/stop use Meta Clinic's lifecycle through its shared heavy-job queue. Worktree edits block switching. Errors remain visible with a retry through **Open review**; `.local/original.log` and `.local/changed.log` hold diagnostic output. Databases and worktrees are retained for reuse. Quit the review server after stopping previews if you want all application services stopped.

## Checks

```powershell
npm test
npm run test:live
```

Unit checks cover exact Git comparisons, invalid refs, session separation, and gateway request boundaries. The live check requires a ready pair. It signs into both with one cookie jar, saves a synthetic draft answer in Changed, verifies persistence and an unchanged Original, then restores the answer. It does not replace a browser walkthrough.

This slice does not approve, merge, push Meta Clinic changes, or deploy. The review app repository can be committed and pushed independently.
