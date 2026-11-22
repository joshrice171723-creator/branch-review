# Install Branch Review on Windows

Download `Branch-Review-0.6.0-Windows-x64-Setup.exe` from the [public v0.6.0 release](https://github.com/joshrice171723-creator/branch-review/releases/tag/v0.6.0), run it, then open Branch Review from Start. The beta installer is unsigned; Windows may display an unknown-publisher warning. Only use a download you trust, and compare its SHA-256 with `SHA256SUMS.txt` if verifying a shared file.

The installer includes the desktop runtime. It does not include your project, accounts, Git, or your project's build tools. It installs for your Windows user and does not require administrator installation. Updates use the same installer; uninstall keeps reviews and project files. There is no automatic updater yet.

## First project

1. Install [Git for Windows](https://git-scm.com/downloads/win). Clone your project with your usual Git client and ensure it has an `origin` remote and a commit.
2. Open Branch Review and choose your project folder. Confirm that you trust the project before opening it.
3. Install any version or service your project requires. Automatic npm previews use the root `package-lock.json`.
4. To use agent features, install and sign in to your selected coding agent. Choose it in Branch Review. You use your own provider account and usage allowance.

Claude Code 2.1.259 or later supports the flags used for restricted agent jobs.

The Windows installer includes private Python 3.13.17, Ruby 3.4.13, Node.js 24.19.0, and npm.

Current Setup builds show measured percentages while preparing Setup and unpacking app files.
Applying installation changes covers the final file copy and Windows registration.
The status reaches 100% installed when the native installer finishes successfully.
Workbench uses these runtimes without changing your system PATH.
5. Fix flagged setup items and select Check again. The guide can fetch remote branches. Choose Start reviewing, then a branch. If you have no branch yet, choose Make changes and describe what you want; the agent creates an isolated branch from the latest remote default branch. Compare Original and Changed before approving anything.

If Git identity is missing, set your own `git config user.name` and `git config user.email` inside your project. If origin/default branch is missing, configure your real remote, fetch it and run `git remote set-head origin -a`. Branch Review does not create or guess an account identity or remote.

Projects with custom services, credentials, or databases may still require manual preview configuration. Publishing requires your own deployment configuration. Native/mobile projects require a web harness for the embedded preview.

If a project folder moves or a drive is disconnected, startup offers another project without deleting previous reviews. Activity → Stop job ends an active agent/check process and retains its files for inspection; it cannot interrupt Git finalization. Simple Vite source/CSS edits and Next CSS/assets reuse a healthy preview. Dependency and configuration changes restart it.

## Sharing and validation boundary

This repository and its v0.6.0 release are public. Download the installer and checksum from the release linked above. The released installer is a versioned snapshot; current source may contain newer behavior.

Fresh-profile testing is distinct from a clean Windows machine. The Windows installer workflow is configured to build and test on a hosted Windows runner, install silently and check the installed runtime with Node/agent discovery unavailable. Its first run was blocked before execution by GitHub account billing; it is not clean-machine proof. It does not supply provider credentials or prove live agent work on every machine. Live Claude work still requires a signed-in test account. See DISTRIBUTION_AUDIT.md for the tested boundaries.

Build on Windows with `npm ci`, `node node_modules/electron/install.js`, and `npm run installer`.
The build downloads and verifies the exact runtime archives in `desktop/windows-runtimes.json`.
Set `BRANCH_REVIEW_RUNTIME_CACHE` to reuse a folder of these archives.
The installer output goes to `../installers` by default. Set `BRANCH_REVIEW_INSTALLER_OUTPUT` to choose another folder.
