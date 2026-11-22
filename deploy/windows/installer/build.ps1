<#
.SYNOPSIS
  Build the Windows hub installer, dist\Aeneas-Hub-Setup-VERSION.exe, and its SHA-256, on Windows.
.DESCRIPTION
  Uses NSIS 3: the copy Tauri keeps (%LOCALAPPDATA%\tauri\NSIS, there after building the Windows app) or one installed
  from nsis.sourceforge.io.
    powershell -ExecutionPolicy Bypass -File deploy\windows\installer\build.ps1 [-VcRedist path\to\vc_redist.x64.exe]
  Its version is the repository's (tools\version.mjs), the one the hub and every app say; a version given must be the same.

  The installer carries Microsoft's Visual C++ runtime installer (vc_redist.x64.exe), which deploy\install.ps1 runs on
  a PC that lacks the runtime (the Direct link's library needs vcruntime140.dll). It is downloaded here from
  Microsoft's permanent link, or taken from -VcRedist, and carried only when its Authenticode signature is valid and
  Microsoft Corporation's: the same check (Test-VcRedistFile, read out of install.ps1) that install.ps1 makes again
  before it runs it.
#>
param([string]$Version, [string]$VcRedist)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$repoVersion = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if (-not $Version) { $Version = $repoVersion }
if ($Version -notmatch '^[0-9.]+$') { throw 'the version is numbers and dots, like 1.0.2' }
if ($Version -ne $repoVersion) { throw "the installer's version is the repository's ($repoVersion), so the hub it installs says the same; not $Version" }
$out = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$nsis = @((Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'), "${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $nsis) { throw 'NSIS 3 is needed: build the Windows app once (Tauri brings it), or install it from nsis.sourceforge.io' }

# The Visual C++ runtime's installer, kept in build\windows-installer (not in dist, which holds what is released).
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'deploy\install.ps1'), [ref]$null, [ref]$null)
foreach ($name in 'Test-MicrosoftName', 'Test-VcRedistFile') {
  $f = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $f) { throw "deploy\install.ps1 has no function $name" }
  . ([scriptblock]::Create($f.Extent.Text))
}
$parts = Join-Path $repo 'build\windows-installer'
New-Item -ItemType Directory -Force -Path $parts | Out-Null
$vc = Join-Path $parts 'vc_redist.x64.exe'
if ($VcRedist) { Copy-Item -LiteralPath $VcRedist -Destination $vc -Force }
else {
  $vcLink = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
  "downloading the Microsoft Visual C++ runtime installer from $vcLink"
  Remove-Item -Force -ErrorAction SilentlyContinue $vc
  & curl.exe -fsSL --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 20 --max-time 900 -o $vc $vcLink
  if ($LASTEXITCODE) { throw "the Visual C++ runtime installer did not download (curl said $LASTEXITCODE); try again, or give one with -VcRedist" }
}
$chk = Test-VcRedistFile $vc
if (-not $chk.Ok) {
  Remove-Item -Force -ErrorAction SilentlyContinue $vc
  throw "the Visual C++ runtime installer is not Microsoft's x64 runtime, signed by Microsoft (signature $($chk.Status), signer '$($chk.Signer)', product '$($chk.Product)', version '$($chk.Version)'), so it was not used"
}
"carrying $($chk.Product), version $($chk.Version): signature $($chk.Status), signed by $($chk.Signer), SHA-256 $((Get-FileHash $vc -Algorithm SHA256).Hash.ToLower())"

& $nsis /V2 "/DVERSION=$Version" "/DOUTDIR=$out" "/DVCREDIST=$vc" (Join-Path $PSScriptRoot 'aeneas-hub.nsi')
if ($LASTEXITCODE) { throw "makensis failed ($LASTEXITCODE)" }
$exe = Join-Path $out "Aeneas-Hub-Setup-$Version.exe"
$sum = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
[IO.File]::WriteAllText("$exe.sha256", "$sum  $(Split-Path $exe -Leaf)`n")
"built $exe ($([math]::Round((Get-Item $exe).Length / 1KB)) KB), sha256 $sum"
