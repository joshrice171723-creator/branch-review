import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scenarioRecipe } from './reviews.mjs';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const local = process.env.BRANCH_REVIEW_HOME || path.join(root, ".local");
const config = JSON.parse(
  await readFile(path.join(local, "config.json"), "utf8").catch(
    () => "{}",
  ),
);
export const repo =
  process.env.META_CLINIC_REPO ||
  config.repository ||
  "C:/Users/joshr/Desktop/meta_clinic";
export const previewRoot = path.resolve(
  config.previewRoot || path.join(root, "../../work/previews"),
);
export const toolchain =
  config.toolchain ||
  path.resolve(root, "../../work/toolchain/node_modules/.bin");
export const slots = {
  original: { web: 3410, api: 3411, postgres: 54541, proxy: 4311 },
  changed: { web: 3420, api: 3421, postgres: 54542, proxy: 4312 },
};
export const state = {
  status: "idle",
  phase: "Choose a branch to begin",
  log: [],
  original: null,
  changed: null,
  error: null,
};
await mkdir(local, { recursive: true });
const exists = async (p) =>
  access(p).then(
    () => true,
    () => false,
  );

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      windowsHide: true,
      ...options,
      shell: false,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output = (output + chunk).slice(-120000);
      options.onOutput?.(String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      output = (output + chunk).slice(-120000);
      options.onOutput?.(String(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(
            new Error(`${command} exited ${code}:\n${output.slice(-5000)}`),
          ),
    );
  });
}
export const git = (...args) => run("git", args);
export function progress(message) {
  state.phase = message;
  state.log.push({ at: new Date().toISOString(), message });
  state.log = state.log.slice(-80);
}
async function assertOwner() {
  const marker = path.join(previewRoot, ".branch-review-owner.json");
  if (await exists(previewRoot)) {
    const owner = JSON.parse(await readFile(marker, "utf8").catch(() => "{}"));
    if (![root, "branch-review/v1"].includes(owner.app) || owner.repository !== repo)
      throw new Error(
        "Preview directory is not owned by this app. Choose a new empty previewRoot in .local/config.json.",
      );
  } else {
    await mkdir(previewRoot, { recursive: true });
    await writeFile(marker, JSON.stringify({ app: "branch-review/v1", repository: repo }));
  }
}
export async function branches() {
  const merged = new Set((await git('for-each-ref', '--merged=refs/remotes/origin/main', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin')).split('\n'));
  const output = await git(
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)%09%(objectname)%09%(subject)%09%(committerdate:iso8601-strict)",
    "refs/heads",
    "refs/remotes/origin",
  );
  const inventory = output
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.startsWith("refs/remotes/origin/HEAD\t"))
    .map((line) => {
      const [ref, sha, subject, date] = line.split("\t");
      return {
        ref,
        sha,
        subject,
        date,
        name: ref.replace(/^refs\/(heads\/|remotes\/)/, ""),
        remote: ref.startsWith("refs/remotes/"),
        merged: merged.has(ref),
        aliases: [],
      };
    });
  const locals = new Map(inventory.filter(b => !b.remote).map(b => [b.name, b]));
  return inventory.filter(branch => {
    const localBranch = branch.remote && locals.get(branch.name.replace(/^origin\//, ''));
    if (localBranch && localBranch.sha === branch.sha) { localBranch.aliases.push(branch.ref); return false; }
    return true;
  });
}
export async function comparison(ref, baseline) {
  if (!["merge-base", "parent"].includes(baseline))
    throw new Error("Choose a listed baseline.");
  const entry = (await branches()).find((b) => b.ref === ref || b.aliases.includes(ref));
  const branch = entry && {...entry, ref};
  if (!branch)
    throw new Error("Branch no longer exists. Refresh the branch list.");
  const main = await git("rev-parse", "refs/remotes/origin/main");
  const base =
    baseline === "parent"
      ? await git("rev-parse", `${branch.sha}^`)
      : await git("merge-base", main, branch.sha);
  const files = (await git("diff", "--name-only", base, branch.sha))
    .split("\n")
    .filter(Boolean);
  return { branch, base, main, baseline, files };
}
function environment(side, sha) {
  const slot = slots[side];
  return {
    ...process.env,
    PATH: `${toolchain}${path.delimiter}${process.env.PATH}`,
    APP_DEVELOPMENT_LOGIN: "1",
    QA_BUILD_URL: `http://127.0.0.1:${slot.web}/build.json`,
    BRANCH_REVIEW_REVISION: sha,
    APPLY_POSTGRES_CONTAINER: `apply-review-${side}`,
    PGPORT: String(slot.postgres),
    APPLY_DEVELOPMENT_DATABASE: `apply_review_${side}_${sha.slice(0, 12)}_development`,
    APPLY_WEB_PORT: String(slot.web),
    APPLY_API_PORT: String(slot.api),
    APPLY_API_READINESS_TIMEOUT: "300",
  };
}
async function lifecycle(side, sha, action) {
  const cwd = path.join(previewRoot, side);
  if (action === 'stop') await clearDeadPidRecords(cwd);
  const env = environment(side, sha);
  progress(`${side === "original" ? "Original" : "Changed"} · ${action}`);
  const logfile = path.join(local, `${side}.log`);
  const output = await run(
    "python",
    [
      path.join(repo, "bin/agent-resources"),
      "run",
      "--",
      "ruby",
      "bin/dev",
      action,
      ...(action === "start" ? ["--no-browser"] : []),
    ],
    {
      cwd,
      env,
      onOutput: (chunk) => {
        const phase = chunk.split("\n").find((line) => line.startsWith("==> "));
        if (phase) state.lastOutput = phase.replace("==> ", "").trim();
      },
    },
  ).catch(async (error) => {
    if (action === 'stop' && await clearDeadPidRecords(cwd)) { await lifecycle(side,sha,action); return 'Recovered stopped process records.'; }
    await writeFile(logfile, error.message);
    throw error;
  });
  await writeFile(logfile, output);
}
export async function clearDeadPidRecords(cwd) {
  if (process.platform !== 'win32') return 0;
  let removed = 0;
  for (const role of ['api','web','worker']) {
    const filename = path.join(cwd,'tmp/dev/pids',`${role}.pid`);
    const record = JSON.parse(await readFile(filename,'utf8').catch(e=>{if(e.code==='ENOENT')return 'null';throw e;}));
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0 || path.resolve(record.root) !== path.resolve(cwd) || record.role !== role) continue;
    const alive = await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',`[bool](Get-Process -Id ${record.pid} -ErrorAction SilentlyContinue)`]);
    if (alive === 'False') { await unlink(filename); removed++; }
  }
  return removed;
}
export async function prepare(side, sha) {
  const cwd = path.join(previewRoot, side);
  await assertOwner();
  if (!(await exists(cwd))) await git("worktree", "add", "--detach", cwd, sha);
  const common = await run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd },
  );
  const expected = await git(
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  if (path.resolve(common) !== path.resolve(expected))
    throw new Error(`Refusing unrelated checkout: ${cwd}`);
  const dirty = await run("git", ["status", "--porcelain"], { cwd });
  if (dirty)
    throw new Error(
      `${side} preview has edits. Preserve them before switching.\n${dirty}`,
    );
  const current = await run("git", ["rev-parse", "HEAD"], { cwd });
  await lifecycle(side, current, "stop");
  await run("git", ["checkout", "--detach", sha], { cwd });
  await lifecycle(side, sha, "setup");
  progress(
    `${side === "original" ? "Original" : "Changed"} · preparing review scenario`,
  );
  const scenarioOutput = await run(
    "ruby",
    [
      "bin/postgres",
      "exec",
      "bin/rails",
      "runner",
      path.join(root, scenarioRecipe(state.comparison.files)),
    ],
    {
      cwd: path.join(cwd, "apps/api"),
      env: environment(side, sha),
    },
  );
  const scenarioLine = scenarioOutput
    .split("\n")
    .find((line) => line.startsWith("BRANCH_REVIEW="));
  if (!scenarioLine)
    throw new Error("The intake scenario did not return a destination.");
  const scenario = JSON.parse(scenarioLine.slice("BRANCH_REVIEW=".length));
  await lifecycle(side, sha, "start");
  return {
    side,
    sha,
    ...slots[side],
    database: environment(side, sha).APPLY_DEVELOPMENT_DATABASE,
    scenario,
  };
}
export async function startReview(ref, baseline) {
  state.status = "preparing";
  state.error = null;
  state.original = null;
  state.changed = null;
  state.log = [];
  try {
    const selected = await comparison(ref, baseline);
    Object.assign(state, { comparison: selected });
    state.original = await prepare("original", selected.base);
    state.changed = await prepare("changed", selected.branch.sha);
    state.status = "ready";
    progress("Both previews are ready");
    await writeFile(
      path.join(local, "review.json"),
      JSON.stringify(
        {
          comparison: selected,
          original: state.original,
          changed: state.changed,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    state.status = "error";
    state.error = error.message;
    progress("Preview preparation needs attention");
  }
}
export async function stopReview() {
  state.status = "stopping";
  try {
    await assertOwner();
    for (const side of ["original", "changed"]) {
      if (await exists(path.join(previewRoot, side))) {
        const sha = await run("git", ["rev-parse", "HEAD"], {
          cwd: path.join(previewRoot, side),
        });
        await lifecycle(side, sha, "stop");
      }
    }
    state.status = "idle";
    state.original = null;
    state.changed = null;
    progress("Previews stopped");
    await writeFile(path.join(local, "review.json"), "{}");
  } catch (error) {
    state.status = "error";
    state.error = error.message;
  }
}
export async function restoreReview() {
  const previous = JSON.parse(
    await readFile(path.join(local, "review.json"), "utf8").catch(() => "{}"),
  );
  if (!previous.original || !previous.changed) return;
  try {
    await assertOwner();
    for (const side of ["original", "changed"]) {
      const slot = previous[side];
      const head = await run("git", ["rev-parse", "HEAD"], {
        cwd: path.join(previewRoot, side),
      });
      if (head !== slot.sha)
        throw new Error("Preview checkout revision changed.");
      if (
        await run("git", ["status", "--porcelain"], {
          cwd: path.join(previewRoot, side),
        })
      )
        throw new Error("Preview checkout has edits.");
      const response = await fetch(`http://127.0.0.1:${slot.api}/up`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error("Preview stopped.");
      const web = await fetch(`http://127.0.0.1:${slot.web}/login`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!web.ok) throw new Error("Frontend stopped.");
    }
    Object.assign(state, previous, {
      status: "ready",
      phase: "Restored running previews",
    });
  } catch {
    state.phase =
      "Previous previews need restarting. Select the branch and open review.";
  }
}
