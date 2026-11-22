import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Windows hub installer and the Microsoft Visual C++ runtime the Direct link needs (deploy/install.ps1,
 * deploy/windows/installer). The checks themselves run on Windows (deploy/windows/test-vcruntime.ps1); this keeps the
 * pieces joined up on every system: the build carries a checked copy, install.ps1 checks it again before an
 * administrator runs it, under the one permission prompt, and a failure does not stop the install.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const install = read("deploy/install.ps1");
const nsi = read("deploy/windows/installer/aeneas-hub.nsi");
const build = read("deploy/windows/installer/build.ps1");

test("windows installer: install.ps1 has the runtime checks the build and the test script read out of it", () => {
  for (const name of ["Test-VcRuntimeEntry", "Test-VcRuntime", "Test-MicrosoftName", "Test-VcRedistFile"]) {
    assert.match(install, new RegExp(`\\n  function ${name} \\{\\n    param\\(`), `${name} with a param block (copied into the elevated script)`);
  }
  assert.ok(install.includes("'HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'"));
  assert.ok(install.includes("'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64'"));
  assert.ok(install.includes("System32\\vcruntime140.dll"));
  for (const name of ["Test-MicrosoftName", "Test-VcRedistFile"]) assert.ok(build.includes(`'${name}'`), `build.ps1 reads ${name} out of install.ps1`);
  assert.ok(read("deploy/windows/test-vcruntime.ps1").includes("'Test-VcRuntimeEntry', 'Test-VcRuntime', 'Test-MicrosoftName', 'Test-VcRedistFile'"));
});

test("windows installer: the build carries the runtime's installer only after its signature check", () => {
  assert.ok(build.includes("https://aka.ms/vs/17/release/vc_redist.x64.exe"), "Microsoft's permanent link");
  const check = build.indexOf("$chk = Test-VcRedistFile $vc");
  const nsis = build.indexOf("& $nsis");
  assert.ok(check > 0 && nsis > check, "checked before makensis runs");
  assert.match(build.slice(check, nsis), /if \(-not \$chk\.Ok\) \{[^}]*Remove-Item[^}]*throw/);
  assert.ok(build.slice(nsis).includes('"/DVCREDIST=$vc"'));
  assert.match(nsi, /!ifdef VCREDIST\n {2}File "\/oname=vc_redist\.x64\.exe" "\$\{VCREDIST\}"\n {2}System::Call 'Kernel32::SetEnvironmentVariable\(t "EA_VC_REDIST", t "\$PLUGINSDIR\\vc_redist\.x64\.exe"\)i'\n!endif/);
  assert.match(nsi, /RequestExecutionLevel user/, "the installer itself never asks for an administrator");
});

test("windows installer: install.ps1 installs the runtime under the one permission prompt, checked again first, and goes on if it fails", () => {
  assert.match(install, /if \(\$msi -or \$vcExe -or -not \$taskOk -or \$needFw -or \$dropFw\) \{/, "the runtime alone is reason enough for the prompt");
  assert.equal(install.match(/-Verb RunAs/g)?.length, 1, "one prompt, as before");
  // The elevated script: the functions after its param line, then the runtime checked again just before it runs.
  assert.ok(install.includes('Write-Text $reg ("param([string]`$Spec)`nfunction Test-MicrosoftName {${function:Test-MicrosoftName}}`nfunction Test-VcRedistFile {${function:Test-VcRedistFile}}`n" + @\''));
  const elevated = install.slice(install.indexOf("if ($j.vcredist) {"), install.indexOf("if ($j.msi) {"));
  assert.ok(elevated.indexOf("(Test-VcRedistFile ([string]$j.vcredist)).Ok") < elevated.indexOf("Start-Process -FilePath ([string]$j.vcredist)"));
  assert.ok(elevated.includes('"/install /quiet /norestart /log'));
  assert.doesNotMatch(elevated, /\bexit\b|throw/, "a failed runtime install stops nothing after it");
  // Before the prompt: a copy that is not Microsoft's is never handed on.
  const before = install.slice(install.indexOf("$vc = Test-VcRuntime"), install.indexOf("if ($msi -or $vcExe"));
  assert.match(before, /\$chk = Test-VcRedistFile \$vcExe\n\s+if \(\$chk\.Ok\)[^\n]*\n\s+else \{\n[^\n]*\n\s+\$vcExe = ''/);
  // After it: what happened, in plain words, never a stop.
  const after = install.slice(install.indexOf("if ($vcExe) {\n        $said"), install.indexOf("if ($needFw -and -not"));
  assert.match(after, /The hub still installs; the Direct link stays off until the runtime is on this PC\. \$vcFix/);
  assert.doesNotMatch(after, /\bFail\b/);
});
