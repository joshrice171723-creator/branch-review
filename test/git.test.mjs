import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
mkdirSync(path.join(app, ".local"), { recursive: true });
const fixture = mkdtempSync(path.join(app, ".local/git-test-"));
const git = (...args) =>
  execFileSync("git", args, {
    cwd: fixture,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
git("init", "-b", "main");
git("config", "user.name", "Review Test");
git("config", "user.email", "review@example.invalid");
writeFileSync(path.join(fixture, "intake.txt"), "original");
git("add", ".");
git("commit", "-m", "Original intake");
const base = git("rev-parse", "HEAD");
git("update-ref", "refs/remotes/origin/main", base);
git("checkout", "-b", "intake-controls");
writeFileSync(path.join(fixture, "intake.txt"), "changed");
git("commit", "-am", "Improve intake controls");
const candidate = git("rev-parse", "HEAD");
git('update-ref','refs/remotes/origin/intake-controls',candidate);
git('update-ref','refs/heads/already-merged',base);
git('update-ref','refs/heads/diverged',candidate);
git('update-ref','refs/remotes/origin/diverged',base);
process.env.META_CLINIC_REPO = fixture;
const { branches, comparison } = await import("../adapter.mjs");

test("branch inventory identifies exact revisions; both baselines resolve the real diff", async () => {
  const list = await branches();
  assert.equal(list.find((b) => b.name === "intake-controls").sha, candidate);
  for (const mode of ["parent", "merge-base"]) {
    const result = await comparison("refs/heads/intake-controls", mode);
    assert.equal(result.base, base);
    assert.equal(result.branch.sha, candidate);
    assert.deepEqual(result.files, ["intake.txt"]);
  }
  assert.equal(git("status", "--porcelain"), "");
});
test("unknown refs and unsupported baselines cannot enter the lifecycle", async () => {
  await assert.rejects(
    comparison("--upload-pack=not-a-command", "parent"),
    /Branch no longer exists/,
  );
  await assert.rejects(
    comparison("refs/heads/intake-controls", "arbitrary"),
    /listed baseline/,
  );
});
test('merged refs are classified and identical local/remote copies collapse without hiding divergent versions', async () => {
  const list = await branches();
  assert.equal(list.find(b=>b.name==='already-merged').merged,true);
  assert.equal(list.find(b=>b.name==='intake-controls').merged,false);
  assert.deepEqual(list.find(b=>b.name==='intake-controls').aliases,['refs/remotes/origin/intake-controls']);
  assert.equal(list.some(b=>b.ref==='refs/remotes/origin/intake-controls'),false);
  assert.equal(list.filter(b=>b.name==='diverged'||b.name==='origin/diverged').length,2);
  const remote = await comparison('refs/remotes/origin/intake-controls','parent');
  assert.equal(remote.branch.sha,candidate);assert.equal(remote.branch.ref,'refs/remotes/origin/intake-controls');
});
