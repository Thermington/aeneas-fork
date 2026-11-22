<#
.SYNOPSIS
  Tests of deploy\install.ps1's checks for the Microsoft Visual C++ runtime, on Windows.
.DESCRIPTION
  The functions (Test-VcRuntimeEntry, Test-VcRuntime, Test-MicrosoftName, Test-VcRedistFile) are read out of
  install.ps1 itself, so what is tested is what runs. Nothing is installed and nothing outside build\test-vcruntime in
  this copy is written.
    powershell -ExecutionPolicy Bypass -File deploy\windows\test-vcruntime.ps1 [-Redist path\to\vc_redist.x64.exe] [-ExpectPresent]
  With -Redist it also checks that file (signed by Microsoft, so it passes) and a copy with one byte changed (fails).
  With -ExpectPresent this PC's own runtime must be found. Exit code 0 when every check passes.
#>
param([string]$Redist, [switch]$ExpectPresent)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'deploy\install.ps1'), [ref]$null, [ref]$null)
foreach ($name in 'Test-VcRuntimeEntry', 'Test-VcRuntime', 'Test-MicrosoftName', 'Test-VcRedistFile') {
  $f = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $f) { throw "deploy\install.ps1 has no function $name" }
  . ([scriptblock]::Create($f.Extent.Text))
}

$script:failed = 0
function Check([string]$what, [bool]$ok) {
  if ($ok) { Write-Host "ok    $what" } else { Write-Host "FAIL  $what" -ForegroundColor Red; $script:failed++ }
}
$tmp = Join-Path $repo 'build\test-vcruntime'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  # The registry entry's values.
  Check 'entry: Installed 1, Major 14 is installed' (Test-VcRuntimeEntry ([pscustomobject]@{ Installed = 1; Major = 14 }))
  Check 'entry: values read as text count the same' (Test-VcRuntimeEntry ([pscustomobject]@{ Installed = '1'; Major = '14' }))
  Check 'entry: a later Major counts' (Test-VcRuntimeEntry ([pscustomobject]@{ Installed = 1; Major = 15 }))
  Check 'entry: Installed 0 is not installed' (-not (Test-VcRuntimeEntry ([pscustomobject]@{ Installed = 0; Major = 14 })))
  Check 'entry: an older Major (12) is not this runtime' (-not (Test-VcRuntimeEntry ([pscustomobject]@{ Installed = 1; Major = 12 })))
  Check 'entry: no Major is not installed' (-not (Test-VcRuntimeEntry ([pscustomobject]@{ Installed = 1 })))
  Check 'entry: a value that is not a number is not installed' (-not (Test-VcRuntimeEntry ([pscustomobject]@{ Installed = 'yes'; Major = 14 })))
  Check 'entry: no entry is not installed' (-not (Test-VcRuntimeEntry $null))

  # Where it looks: registry paths and a DLL that do not exist give the not-present path.
  $none = Test-VcRuntime -Keys @('HKLM:\SOFTWARE\AeneasTestNoSuchKey\VC\Runtimes\x64', 'HKCU:\Software\AeneasTestNoSuchKey') -Dll (Join-Path $tmp 'no-such-vcruntime140.dll')
  Check "nothing there: not present (Present=$($none.Present))" (-not $none.Present -and $none.From -eq '')
  $fake = Join-Path $tmp 'vcruntime140.dll'
  [IO.File]::WriteAllText($fake, 'stand-in')
  $byDll = Test-VcRuntime -Keys @('HKLM:\SOFTWARE\AeneasTestNoSuchKey\VC\Runtimes\x64') -Dll $fake
  Check 'no registry entry but the DLL: present, from the DLL' ($byDll.Present -and $byDll.From -eq 'dll')
  $here = Test-VcRuntime
  Write-Host "      this PC: Present=$($here.Present) From=$($here.From) Version=$($here.Version)"
  if ($ExpectPresent) { Check 'this PC: present' ([bool]$here.Present) }

  # Certificate names.
  $ms = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'
  Check 'name: Microsoft Corporation as CN and O' (Test-MicrosoftName $ms)
  Check 'name: the order does not matter' (Test-MicrosoftName 'O=Microsoft Corporation, CN=Microsoft Corporation, C=US')
  Check "name: Microsoft's signing CA as issuer" (Test-MicrosoftName 'CN=Microsoft Code Signing PCA 2011, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' -Issuer)
  Check "name: the CA's name is not a signer's" (-not (Test-MicrosoftName 'CN=Microsoft Code Signing PCA 2011, O=Microsoft Corporation, C=US'))
  Check 'name: a longer CN is someone else' (-not (Test-MicrosoftName 'CN=Microsoft Corporation Ltd, O=Microsoft Corporation'))
  Check 'name: a longer O is someone else' (-not (Test-MicrosoftName 'CN=Microsoft Corporation, O=Microsoft Corporation Example'))
  Check 'name: OU is not O' (-not (Test-MicrosoftName 'CN=Microsoft Corporation, OU=Microsoft Corporation, O=Example Ltd'))
  Check 'name: the case must match' (-not (Test-MicrosoftName 'CN=microsoft corporation, O=microsoft corporation'))
  Check 'name: a quoted CN holding a comma is not split' (-not (Test-MicrosoftName 'CN="Microsoft Corporation, O=Microsoft Corporation", O=Example Ltd'))
  Check 'name: empty is no one' (-not (Test-MicrosoftName ''))

  # Files.
  $miss = Test-VcRedistFile (Join-Path $tmp 'no-such.exe')
  Check 'file: missing' (-not $miss.Ok -and $miss.Status -eq 'missing')
  $unsigned = Join-Path $tmp 'unsigned.exe'
  [IO.File]::WriteAllBytes($unsigned, [byte[]](@(0x4D, 0x5A) + @(0) * 512))
  $u = Test-VcRedistFile $unsigned
  Check "file: unsigned is refused (signature $($u.Status))" (-not $u.Ok -and $u.Status -ne 'Valid')
  $np = Join-Path $env:WINDIR 'System32\notepad.exe'
  if (Test-Path $np) {
    $n = Test-VcRedistFile $np
    Check "file: a Windows program, not the runtime's installer, is refused (signature $($n.Status), $($n.Product))" (-not $n.Ok)
  }
  if ($Redist) {
    $r = Test-VcRedistFile $Redist
    Write-Host "      $Redist`: signature $($r.Status), signer $($r.Signer), $($r.Product), version $($r.Version)"
    Check 'file: the runtime installer from Microsoft passes' ([bool]$r.Ok)
    $bent = Join-Path $tmp 'vc_redist.x64.exe'
    $bytes = [IO.File]::ReadAllBytes($Redist)
    $at = [int]($bytes.Length / 2)
    $bytes[$at] = $bytes[$at] -bxor 0xFF
    [IO.File]::WriteAllBytes($bent, $bytes)
    $b = Test-VcRedistFile $bent
    Check "file: a copy with one byte changed is refused (signature $($b.Status))" (-not $b.Ok -and $b.Status -ne 'Valid')
  }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}
if ($script:failed) { Write-Host "$($script:failed) failed" -ForegroundColor Red; exit 1 }
Write-Host 'all passed'
