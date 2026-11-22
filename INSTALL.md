# Install Branch Review on Windows

Download `Branch-Review-0.6.0-Windows-x64-Setup.exe` from the [public v0.6.0 release](https://github.com/joshrice171723-creator/branch-review/releases/tag/v0.6.0), run it, then open Branch Review from Start. The beta installer is unsigned; Windows may display an unknown-publisher warning. Only use a download you trust, and compare its SHA-256 with `SHA256SUMS.txt` if verifying a shared file.

The installer includes the desktop runtime. It does not include your project, accounts, Git, or your project's build tools. It installs for your Windows user and does not require administrator installation. Updates use the same installer; uninstall keeps reviews and project files. There is no automatic updater yet.

## First project

1. Install [Git for Windows](https://git-scm.com/downloads/win). Clone your project with your usual Git client and ensure it has an `origin` remote and a commit.
2. Open Branch Review and choose your project folder. Confirm that you trust the project before opening it.
3. Install any version or service your project requires. Automatic npm previews use the root `package-lock.json`.
4. Install and sign in to the agent providers you use. Select the workflow providers and models in Configure.
5. Open Design and describe a change. Review the plan and select Start build. Use Build readiness to prepare the project.
6. When the build reaches review, compare Original and Changed and complete the checklist. Approve that commit before you push.

To review an existing branch, select Review a branch. Claude Code 2.1.259 or later supports restricted Branch Review jobs.

Branch Review uses Electron for the workspace and built-in static previews.
Install Node.js with npm for automatic Vite and Next previews.
Install Python and Ruby for Meta Clinic previews.

Setup reports percentages while it prepares and unpacks app files.
The final step copies app files and registers the app with Windows.
Setup reports 100% after installation succeeds.

If Git identity is missing, set your own `git config user.name` and `git config user.email` inside your project. If origin/default branch is missing, configure your real remote, fetch it and run `git remote set-head origin -a`. Branch Review does not create or guess an account identity or remote.

Projects with custom services, credentials, or databases may still require manual preview configuration. Publishing requires your own deployment configuration. Native/mobile projects require a web harness for the embedded preview.

If a project folder moves or a drive is disconnected, startup offers another project without deleting previous reviews. Activity → Stop job ends an active agent/check process and retains its files for inspection; it cannot interrupt Git finalization. Simple Vite source/CSS edits and Next CSS/assets reuse a healthy preview. Dependency and configuration changes restart it.

## Sharing and validation boundary

This repository and its v0.6.0 release are public. Download the installer and checksum from the release linked above. The released installer is a versioned snapshot; current source may contain newer behavior.

The Windows installer workflow builds and installs on a hosted Windows runner.
The smoke test uses installed Electron and Git on a restricted PATH.
It checks project preparation, workspace bootstrap, and MCP initialization.
See DISTRIBUTION_AUDIT.md for the earlier release validation.

Build on Windows with `npm ci` and `npm run installer`.
The installer output goes to `../installers` by default. Set `BRANCH_REVIEW_INSTALLER_OUTPUT` to choose another folder.
