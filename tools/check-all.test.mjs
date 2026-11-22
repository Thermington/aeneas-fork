import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { stepEnv, workflowSteps } from "./check-all.mjs";

const workflow = (file) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");

test("the check before a push reads every command CI runs, from the workflows themselves", () => {
  const ci = workflowSteps(workflow("ci.yml")).map((s) => s.run);
  for (const run of ["npm ci", "npm --workspace hub test", "npm --workspace web test", "npm --workspace web run build", "npm run license-check", "node --test tools/check-all.test.mjs"]) {
    assert.ok(ci.includes(run), run);
  }
  assert.ok(!ci.some((r) => r.startsWith("actions/")), "uses: steps are left out");
  const apple = workflowSteps(workflow("apple.yml"));
  assert.deepEqual(apple.at(-1), { name: "swift test (EACore)", run: "swift test", cwd: "apple/Packages/EACore" });
});

test("a workflow it cannot follow is refused, not half read", () => {
  assert.throws(() => workflowSteps("jobs:\n  a:\n    steps:\n      - run: |\n          echo one\n          echo two\n"), /several lines/);
  assert.throws(() => workflowSteps("jobs:\n  a:\n    steps:\n      - run: a\n  b:\n    steps:\n      - run: b\n"), /more than one job/);
  assert.throws(() => workflowSteps("on: push\n"), /no steps/);
});

test("values nested under a step (with:, env:) are not taken for the step's own", () => {
  const steps = workflowSteps("jobs:\n  a:\n    steps:\n      - uses: x@v1\n        with:\n          run: not-a-step\n      - name: Real\n        run: echo real\n        working-directory: sub\n");
  assert.deepEqual(steps, [{ name: "Real", run: "echo real", cwd: "sub" }]);
});


test("a check never runs with git's hook variables, which name the repository being pushed", () => {
  const env = stepEnv({ PATH: "/usr/bin", HOME: "/home/x", GIT_DIR: "/repo/.git/worktrees/side", GIT_WORK_TREE: "/side", GIT_INDEX_FILE: "index", GIT_PREFIX: "hub/", GIT_AUTHOR_NAME: "kept" }, null);
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/x", GIT_AUTHOR_NAME: "kept", CI: "1" });
});

test("on a Mac the selected Xcode is named for every check, unless the caller named one", () => {
  assert.equal(stepEnv({ PATH: "/usr/bin" }, "/Applications/Xcode.app/Contents/Developer").DEVELOPER_DIR, "/Applications/Xcode.app/Contents/Developer");
  assert.equal(stepEnv({ PATH: "/usr/bin", DEVELOPER_DIR: "/mine" }, "/Applications/Xcode.app/Contents/Developer").DEVELOPER_DIR, "/mine");
  assert.equal(stepEnv({ PATH: "/usr/bin" }, null).DEVELOPER_DIR, undefined);
});

test("the SDK git's own shim hands a hook is replaced by the selected Xcode's; one the caller chose is kept", () => {
  const xcode = "/Applications/Xcode_26.6_RC.app/Contents/Developer";
  if (!fs.existsSync(`${xcode}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`)) return;
  assert.equal(stepEnv({ SDKROOT: "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk" }, xcode).SDKROOT, `${xcode}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`);
  assert.equal(stepEnv({ SDKROOT: "/my/sdk" }, xcode).SDKROOT, "/my/sdk");
});
