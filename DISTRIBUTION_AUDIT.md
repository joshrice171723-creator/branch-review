# Windows beta distribution evidence

Date: 2026-10-17. Version: 0.6.0. This is a Windows beta, not clean-machine certification or a claim that every project runs automatically.

## Delivered

- Per-user Windows x64 installer, Start menu/desktop shortcuts, app icon and retained project data on uninstall.
- Missing-Git startup guidance and fixed prerequisite documentation links.
- First-run project/agent checks, direct Codex/Claude selection, fetch-and-recheck, and recovery when a saved repository is unavailable.
- Make changes without an existing feature branch or preview: fetch the remote default branch, edit an isolated checkout, commit through the host, then review the new branch.
- Stop job for agent/check processes. On Windows it stops the owned process tree, retains saved files and never treats cancellation as successful QA or a completed fix. Git finalization is not cancellable.
- Healthy Vite source/CSS and Next CSS/asset updates reuse a preview; dependency/configuration changes restart it.
- Windows package-manager command resolution for npm/pnpm/Yarn entry points, with explicit JavaScript paths and preserved arguments. Custom stacks still need their own recipe and runtime.

## Verified locally

| Check | Evidence |
| --- | --- |
| Automated regression | 124 tests passed, including disposable Git integration, exact-version approval, job cancellation, provider protocols, preview isolation and deployment receipts |
| Real Codex first change | A fresh Field Notes project with only local main accepted a pink-button request, produced a separate committed branch, generated a matching checklist, and left main clean and unchanged |
| Rendered first-run journey | Electron renderer acceptance switched providers, blocked disconnected Claude, completed setup, submitted Make changes, opened Review changes, and checked blue Original / pink Changed computed colors |
| Packaged browser QA runner | The installed runner loaded in Electron visited the real Changed preview, verified pink, clicked Add a note, confirmed its response, and persisted four screenshots; review approval stayed null |
| Real Vite reuse | CSS update reused the same PID and port in 233 ms; Original stayed blue; configuration change restarted the preview process |
| Package-manager launch | Real pnpm 11.19.0 launched through its JS entry; literal argument preservation and Yarn/Corepack discovery have fixture coverage |
| Non-npm preview | Installed Electron ran real Python HTTP previews with Node/agent PATH entries absent; Original and Changed had separate ports/content, healthy reuse worked, and stopping Changed left Original healthy |
| Installed app | Silent install and installed Electron smoke test passed; source/test/local account state excluded, only production dependency included, missing Node/Codex/Claude remained actionable |
| Uninstall/reinstall | Uninstall removed the executable; checked desktop settings and Meta Clinic config/review files retained identical SHA-256 values; reinstall restored the executable and passed installed-runtime smoke |
| Native desktop | Missing Git and invalid-folder retry were exercised; a fresh project opened its correct generated green-button review. The unavailable-project recovery dialog was observed |
| Meta Clinic preservation | Its configuration and saved review stayed unchanged throughout generic-project and installer testing. The final installed app reopened the saved platform review at Changed eac50e2, with the blue header button visible behind the Windows permission dialog; the existing adapter and release paths remain covered by regression tests |

The first silent reinstall test used a forward-slash `/D` destination and returned exit 0 without an executable. Repeating with a native Windows path installed correctly. Installation acceptance requires the actual installed executable and smoke result, never exit code alone.

## Remaining gates

- The GitHub Windows runner did not start: account billing/spending-limit enforcement blocked run [39068226813](https://github.com/joshrice171723-creator/branch-review/actions/runs/39068226813). The checked-in workflow is ready, but has no hosted pass yet.
- Installer/executable signing and automatic updates are not configured.
- The repository is private. Release downloads require access, or the owner can share the installer/checksum directly. Repository visibility was not changed.
- The installed real Claude CLI is signed out. Discovery, version gating, disconnected guidance and the host commit protocol passed; an authenticated Claude edit is not verified.
- A Windows firewall permission prompt appeared for the newly installed app. It was left untouched. Further native interaction was blocked; rendered controls were tested separately in Electron's offscreen acceptance runner.
- The in-app browser connector failed to initialize on this host during the run. This did not count as a product pass or a native desktop test.
- No Meta Clinic production publish, live Muse acceptance, additional real Next/Yarn project, or universal backend/data-isolation guarantee is claimed.

## Reproduce

Run `npm test`, then `npm run installer`. The hosted workflow installs and runs `test/installed-smoke.mjs` using the installed Electron executable with `ELECTRON_RUN_AS_NODE=1`.

Optional `test/vite-live.mjs` takes a disposable Vite fixture with `main` (blue button) and `feature/green-button`. `test/renderer-smoke.cjs` runs in development Electron against an owned server on port 4310 and a disposable Field Notes project; it may create a real Codex job and consume that account's usage. `test/browser-runner-smoke.cjs` uses development Electron with the installed resources/app path to exercise the packaged browser runner. Do not run these against an unrelated active project.

`test/python-live.mjs` runs under installed Electron with `ELECTRON_RUN_AS_NODE=1`, taking the installed `resources/app` directory and an absolute Python executable. It creates disposable static previews on fresh ports and stops them afterward; it does not use the active review controller.
