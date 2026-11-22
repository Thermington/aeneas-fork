#!/usr/bin/env node
// What CI runs, run on this machine before a push (tools/githooks/pre-push). GitHub Actions runs the workflows only in
// the public repository: a private one gets a small monthly allowance of minutes that ran out within days, and every
// push after that failed and sent an email. So this is the private repository's CI. It runs every `run:` step of
// .github/workflows/ci.yml except `npm ci` (the packages installed here are used as they are) and, with --apple, the
// steps of apple.yml, in order, stopping at the first failure. Reading the steps from the workflows keeps the two the
// same: a step added to CI is checked here too.
//
//   node tools/check-all.mjs [--apple]
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STEP_LIMIT_MS = 15 * 60_000;

/**
 * The steps of a workflow's one job that run a command, in order, as `{ name, run, cwd }` (`uses:` steps are left
 * out). A workflow with more than one job, or a step whose command spans several lines, is refused rather than half
 * read, so a change to the workflows that this cannot follow fails the check instead of being skipped.
 */
export function workflowSteps(yaml) {
  const lines = yaml.split("\n");
  const isSteps = (l) => /^\s*steps:\s*$/.test(l);
  const at = lines.findIndex(isSteps);
  if (at < 0) throw new Error("the workflow has no steps");
  if (lines.slice(at + 1).some(isSteps)) throw new Error("the workflow has more than one job: teach tools/check-all.mjs about it");
  const steps = [];
  let indent = null;
  let step = null;
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const lead = line.length - line.trimStart().length;
    indent ??= lead;
    if (lead < indent) break;
    let text = line.trim();
    if (lead === indent && text.startsWith("- ")) {
      step = {};
      steps.push(step);
      text = text.slice(2);
    } else if (lead !== indent + 2 || !step) continue; // a value nested deeper (with:, env:)
    const m = /^([\w-]+):\s*(.*)$/.exec(text);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "run" && /^[|>]/.test(value)) throw new Error("a run step spans several lines: teach tools/check-all.mjs about it");
    step[key] = value;
  }
  return steps.filter((s) => s.run).map((s) => ({ name: s.name || s.run, run: s.run, cwd: s["working-directory"] || "." }));
}

/**
 * What git sets while it runs a hook (`git rev-parse --local-env-vars`): they name the repository being pushed. In a
 * linked worktree GIT_DIR is among them, and with it set every git command the tests run in repositories of their own
 * (the hub's update tests make several) worked on this one instead: a push from a worktree failed nine tests that
 * pass everywhere else.
 */
const GIT_HOOK_VARS = ["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX", "GIT_SHALLOW_FILE", "GIT_COMMON_DIR"];

/**
 * The environment a check runs in: the caller's, with CI set as on GitHub (the license check, for one, fails when it
 * cannot read the Rust crates instead of noting it) and without git's hook variables, so the checks see what they
 * see on GitHub and when run by hand.
 */
export function stepEnv(from, developerDir = selectedXcode()) {
  const env = { ...from, CI: "1" };
  for (const k of GIT_HOOK_VARS) delete env[k];
  // On a Mac, the Xcode that xcode-select names, named again for every tool: with the command line tools also
  // installed, xcrun picked their newer macOS SDK, which the selected Xcode's compiler cannot build with (a macOS
  // update brought one on 2026-11-21 and every swift test failed).
  if (developerDir && !env.DEVELOPER_DIR) env.DEVELOPER_DIR = developerDir;
  // The Xcode's own macOS SDK is named too. Apple's git (through its xcrun shim) hands its hooks SDKROOT set to the
  // command line tools' SDK, so a push's checks built against that one whatever DEVELOPER_DIR said.
  const sdk = developerDir && join(developerDir, "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk");
  if (sdk && existsSync(sdk) && (!env.SDKROOT || env.SDKROOT.startsWith("/Library/Developer/CommandLineTools/"))) env.SDKROOT = sdk;
  return env;
}

/** The developer folder xcode-select names on a Mac (an Xcode, not the command line tools), else null. */
function selectedXcode() {
  if (process.platform !== "darwin") return null;
  try {
    const dir = spawnSync("xcode-select", ["-p"], { encoding: "utf8", timeout: 10_000 }).stdout.trim();
    return dir.includes(".app/") ? dir : null;
  } catch { return null; }
}

function main() {
  const apple = process.argv.includes("--apple");
  const workflow = (file) => readFileSync(join(ROOT, ".github/workflows", file), "utf8");
  const steps = workflowSteps(workflow("ci.yml")).filter((s) => s.run !== "npm ci");
  if (apple && process.platform === "darwin") steps.push(...workflowSteps(workflow("apple.yml")));
  console.log(`Checking before the push: what CI runs (ci.yml${apple ? " and apple.yml" : ""}), about ${apple ? "1.5 minutes" : "1 minute"}.`);
  if (apple && process.platform !== "darwin") console.log("The Apple tests are left out: they need a Mac with Xcode.");
  const changed = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  if (changed) console.log(`Note: ${changed.split("\n").length} files have changes that are not committed; the checks see them as they are, not only what is pushed.`);

  const logs = mkdtempSync(join(tmpdir(), "ea-checks-"));
  const started = Date.now();
  for (const [i, s] of steps.entries()) {
    const log = join(logs, `${String(i + 1).padStart(2, "0")}.log`);
    const fd = openSync(log, "w");
    const t0 = Date.now();
    const r = spawnSync("bash", ["-c", s.run], { cwd: join(ROOT, s.cwd), stdio: ["ignore", fd, fd], env: stepEnv(process.env), timeout: STEP_LIMIT_MS, killSignal: "SIGKILL" });
    closeSync(fd);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.status === 0) {
      console.log(`  ok      ${s.name} (${secs} s)`);
      continue;
    }
    const why = r.error?.code === "ETIMEDOUT" ? `stopped after ${STEP_LIMIT_MS / 60_000} minutes` : r.signal ? `stopped by ${r.signal}` : `exit ${r.status}`;
    console.log(`  FAILED  ${s.name} (${why}, ${secs} s)\n`);
    console.log(readFileSync(log, "utf8").split("\n").slice(-60).join("\n"));
    console.log(`\nWhole output: ${log}\nNothing was pushed. Fix the failure, commit, and push again.`);
    process.exit(1);
  }
  console.log(`All ${steps.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
