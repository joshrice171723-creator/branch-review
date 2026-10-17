# Install Branch Review on Windows

Download `Branch-Review-0.6.0-Windows-x64-Setup.exe` from this repository's release, run it, then open Branch Review from Start. The beta installer is unsigned; Windows may display an unknown-publisher warning. Only use a download you trust, and compare its SHA-256 with `SHA256SUMS.txt` if verifying a shared file.

The installer includes the desktop runtime. It does not include your project, accounts, Git, or your project's build tools. It installs for your Windows user and does not require administrator installation. Updates use the same installer; uninstall keeps reviews and project files. There is no automatic updater yet.

## First project

1. Install [Git for Windows](https://git-scm.com/downloads/win). Clone your project with your usual Git client and ensure it has an `origin` remote and a commit.
2. Install the runtime your project requires. Automatic npm Vite/Next previews need [Node.js with npm](https://nodejs.org/en/download), a root package-lock.json and the project's supported Node version. Other stacks use custom commands in Settings.
3. Install either [Codex CLI](https://developers.openai.com/codex/cli/) or [Claude Code](https://code.claude.com/docs/en/setup), then sign in with `codex login` or `claude auth login`. You use your own provider account and usage allowance. Claude requires version 2.1.259 or later for the restricted job flags used here.
4. Reopen Branch Review after installing tools so it receives your updated PATH. Choose your Git folder, then follow Set up your project. In Settings select your agent; automatic discovery is preferred, with an optional executable path if necessary.
5. Fix flagged setup items and select Check again. Choose Start reviewing, then a branch. Compare Original and Changed, record findings and use Make changes to request a fix.

If Git identity is missing, set your own `git config user.name` and `git config user.email` inside your project. If origin/default branch is missing, configure your real remote, fetch it and run `git remote set-head origin -a`. Branch Review does not create or guess an account identity or remote.

For custom services, configure preview commands and isolated databases in Settings. Publishing requires your own deployment configuration. Native/mobile projects require a web harness for the embedded preview.

## Sharing and validation boundary

This repository is currently private. Its release download requires repository access; alternatively the owner can share the installer and checksum directly. No repository visibility change is made by packaging.

Fresh-profile testing is distinct from a clean Windows machine. The Windows installer workflow builds and tests on a hosted Windows runner, installs silently and checks the installed runtime with Node/agent discovery unavailable. It does not supply provider credentials or prove live agent work on every machine. Live Claude work still requires a signed-in test account.

Installer implementation uses the standard [electron-builder NSIS target](https://www.electron.build/nsis.html). Build with `npm ci`, `node node_modules/electron/install.js`, and `npm run installer`. Outputs are outside source in `../installers`. Only application source and production dependencies are included.
