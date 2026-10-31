# Branch Review

A local desktop workspace for reviewing changes in Git projects: choose a branch, compare isolated versions, report findings, ask Codex for a fix, and retest within the same review.

**[Download the Windows beta](https://github.com/joshrice171723-creator/branch-review/releases/tag/v0.6.0)** · [Installation guide](INSTALL.md) · [Run from source](#get-started)

![Branch Review showing the Changed version of a disposable Field Notes demo and its guided review checklist](docs/screenshots/field-notes-review.png)

Actual Electron screenshot from the October 17, 2026 disposable Field Notes acceptance run: a blue button changed to pink, with the review checklist alongside it. The notes fields are empty and the project contains no patient records. This is a historical capture, not a mockup or a claim that the current live review passed. Current controls may differ. See the [capture procedure](test/renderer-smoke.cjs) and [recorded distribution evidence](DISTRIBUTION_AUDIT.md).

## Status and engineering

Active development. The public Windows 0.6.0 beta is unsigned and is an older snapshot than the current source. There is no hosted browser demo: previews run locally against a trusted Git project. Signing, automatic updates and clean-machine distribution acceptance remain separate work; see [distribution evidence](DISTRIBUTION_AUDIT.md).

The implementation separates review evidence from permission to ship. [Delivery](delivery.mjs) binds approval to a specific commit and refuses a moved default branch; an uncertain push is reconciled before another attempt. [Project delivery](project-delivery.mjs) requires an HTTPS receipt identifying the exact clean commit before reporting a deployment as published. Isolated previews preserve the original/changed comparison without treating a passing page check as complete product acceptance.

Built with Electron and JavaScript, with AI-assisted development using Codex. Generated checklists and fixes are inputs to human review, not a claim of autonomous correctness.

## Get started

Windows users: download the installer from the [public beta release](https://github.com/joshrice171723-creator/branch-review/releases/tag/v0.6.0) and follow [Install Branch Review](INSTALL.md). The beta is unsigned. Source setup requires Node.js 24 or later.

1. Open Branch Review.exe from its packaged folder, or run `npm ci`, `node node_modules/electron/install.js`, then `npm run desktop` from source.
2. Choose a trusted Git repository. Previewing executes project code. Git must be installed; generated checklists and fixes need an installed, signed-in Codex CLI or Claude Code.
3. The first-run **Set up your project** guide checks Git, your remote/default branch, commit identity, previews and your chosen agent. Resolve any flagged items, choose **Check again**, then **Start reviewing**. Reopen the guide from the **Settings** toolbar icon. Existing reviews stay available without repeating setup.
4. Choose a branch, or **Make changes** to start a new change from the remote default branch. The summary appears immediately; the combined result against the remote default branch, checklist and isolated previews prepare before QA.
5. Review each item using **Looks good → Next** or **Needs a change**. Requests collect without running the agent. The request modal fills in the expected result and attaches a screenshot; describe the requested change once. Use the request count to edit or remove entries. After every item is addressed, **Make these N changes** on the summary sends the requests together and opens the new commit on the same branch. Optional notes and exceptions are under **More options**.
   Compare Original and Changed. Select an item or Next to open its screen, record observations and report problems.
   Right-clicking the affected area opens the same request modal. The current page, version and cropped preview screenshot accompany the request. Drafts stay with their review. The separate **Review checklist** toolbar control edits testing instructions.
6. Request more changes on the same local work branch. Codex edits a detached, isolated checkout; Branch Review commits the requested files and advances that branch without creating another branch. The latest Changed preview opens automatically. Original stays at the review's starting baseline, and each new version needs fresh checks. A clean checked-out branch fast-forwards safely; unsaved files or external branch changes preserve the proposal and block applying it. Agent fixes offers **Apply saved commit to this branch** after the blockage is resolved.
7. Use the history icon for **Branch versions**. **Preview** shows earlier files without moving the branch or editing results. **Return to latest version** resumes the current review. **Restore as new commit** restores all tracked files to the selected version, appends a commit to the same branch, and keeps intermediate commits. Saved review reports and evidence remain available below the version list. Nothing is automatically pushed. History shows up to 200 first-parent commits plus the branch starting point; existing legacy fix branches are preserved.
8. Finish the guided review, then approve the exact version from its summary before choosing merge/push or publish. Protected repositories can use **Workspace > Delivery > Create pull request**, with an authenticated GitHub CLI.

## Any project's setup

Projects are not restricted to Meta Clinic. Root npm Vite and Next projects with a package lock have automatic web previews. Other stacks, monorepos and service dependencies use a local recipe in **Workspace > Preview setup**. Install the project's required runtimes first.

Commands are executable-and-argument arrays, not shell strings. Configure the working directory, setup, start command, readiness path, optional services, environment and checks. Example Python server start: `["python","-m","http.server","{port}","--bind","127.0.0.1"]`.

Windows npm, pnpm and Yarn commands resolve their installed JavaScript entry points instead of trying to execute `.cmd` wrappers. Explicit JavaScript entry paths also work. Install the required manager first; custom preview recipes remain necessary for non-npm projects.

Placeholders: `{root}`, `{port}`, `{side}`, `{commit}`, `{data}`. Use `{data}` or revision-specific database names for isolated data. Branch Review cannot isolate an external database hardcoded by a project. Stop previews before editing their recipe. Recipe changes invalidate approval.

Generic previews use separate ports, retain recent healthy versions, reuse dependency setup and stop owned processes on exit. Meta Clinic keeps its existing adapter, data recipes and release integration. Generic projects require no Muse account, Office server or personal filesystem path.

Native/mobile apps and headless tools need an appropriate web harness to use the embedded preview. Configurable project support does not imply automatic knowledge of every build system.

## Review and delivery

The progress strip reports preview and agent activity. Review the changed behavior, collect requests, and verify the resulting revision. A completed manual review can be approved directly from its summary. The former automatic browser QA runner is no longer part of review or approval; it cannot be started from the app or API. Historical results and screenshot evidence remain saved.

Approval remains tied to the exact reviewed commit. Changed branches, moved default branches, preview health, explicit merge/publish confirmation, and deployment receipts retain their existing protections. Project-configured checks remain available under advanced tools. Hosted Meta Clinic release verification is separate from the removed local browser runner.

## Delivery

Git pushes never force-update the remote. A moved default branch requires reviewing a new candidate. GitHub pull requests retain repository protection rules and require `gh` authentication.

Configure a deployment executable/arguments and HTTPS build-receipt URL in Workspace. It runs only after the exact approved commit is pushed. Arguments support `{commit}` and `{root}`. The receipt must return JSON with `revision` equal to that commit and `dirty` false or absent. Command success without a matching receipt is not Published. Uncertain deployments require an inspection note before retrying.

Credentials and deployment setup belong to the project. No provider credentials are installed automatically.

## Storage and boundaries

Each project has local config, plans, reviews, evidence and worktrees. `BRANCH_REVIEW_HOME` overrides its data directory. Desktop project selection is stored in user-data. Config accepts `repository`, `previewRoot`, and optional `toolchain` for Meta Clinic's pinned package manager. `META_CLINIC_REPO` remains a compatibility override.

Checklists come from the actual diff and routes in a read-only checkout and stay outside project source. They are proposed testing instructions, not proof. Legacy checklist files cannot block candidate preparation; application conflicts still require resolution. Unrelated edits are preserved.

Codex jobs disable unrelated connectors, plugins, apps and hooks for that process without altering global configuration. Claude disconnected-state support remains; live Claude acceptance is deferred.

Loopback ports 4310-4312 are reserved. Only one controller can own them. The desktop renderer is sandboxed, and preview content cannot invoke privileged desktop controls. Running project commands is not an operating-system security sandbox.

## More tools

- **Review checklist:** edit proposed checks and routes; changes invalidate approval.
- **Updates & fixes:** findings, jobs, fix retesting and history.
- **Evidence:** screenshots, annotations, recordings and interaction replay.
- **Checks:** configured commands, accessibility and performance checks.
- **Published review:** existing Meta Clinic hosted-review integration.
- **Workspace:** repository, CLI diagnostics, preview setup and delivery.

Reports include outcomes, findings, screenshots, approval and delivery history. Old requests remain in history; save errors are visible.

## Development

Run `npm run dev` from this repository to open the Electron app directly from source; no installer or packaging is needed. Development uses its own `.local-dev` settings and review data, so choose a trusted project on first launch. It shares ports 4310–4313 with the installed app: close the other Branch Review window before starting it. The development window is labeled **Branch Review — Development**.

For changes under `public/`, save your work and press F5 or Ctrl+R in the development window; confirm after saving any form edits. Server, desktop, or dependency changes require closing and reopening `npm run dev`. Refresh does not restart the server or automatically reload unsaved changes. Reviews and evidence created in development stay separate from the installed app. Make an installer only for distribution or when updating the installed copy.

`npm test` includes disposable Git repositories, actual custom-preview processes, provider protocol tests and browser-evidence validation. `npm run package:desktop` builds Windows x64. `npm start` provides the web UI; desktop capture and browser runs require Electron.

Meta Clinic's `npm run test:live` and `node test/qa-live.mjs` need their matching prepared preview pair. `npm run installer` creates the unsigned Windows x64 installer. The Windows installer workflow is configured for a fresh hosted runner, but account billing currently blocks it from starting. Signing and automatic updates remain separate distribution work. See [distribution evidence](DISTRIBUTION_AUDIT.md).

### Preview database cleanup

In Settings, choose **Inspect databases** under Preview databases. Branch Review lists matching databases in its Meta Clinic preview containers, their sizes, known commits and review titles. Start a stopped preview container from the list to inspect it; starting it leaves the container running. Docker must be available. Missing containers do not establish whether an earlier Docker engine or disk still contains data.

Active or prepared databases, databases with connections, and databases without a matching local preview cache cannot be selected. Cleanup requires an explicit selection and confirmation, deletes only the listed databases, and invalidates their preview caches. Saved review history and evidence are retained. Reopening a deleted preview requires its normal setup and synthetic scenario to run again. No database is deleted automatically on merge.
