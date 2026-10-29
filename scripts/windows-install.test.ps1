# Run with: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-install.test.ps1
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '..\install.ps1'
$originalPath = $env:PATH
$originalLocalAppData = $env:LOCALAPPDATA
$originalUserProfile = $env:USERPROFILE
$state = @{ installed = $false; installs = 0; uninstalls = 0; ref = ''; running = $true; started = $false; failInstall = $false; bunVersion = '1.4.2'; failBun = $false; windowsRelease = $true; refId = 'devswha.ovis'; installedId = ''; manifestBlocked = $false; startedLegacy = $false; legacyInstalled = $false; stopStateDirs = @(); handStarted = $false }
$global:herdrInstallOpened = @()
# gh is a stand-in .cmd, first on PATH: the installer runs gh as a process, and no real star is read or given.
# mode.txt beside it is what it answers: starred, not, refuses (the star itself), upstream, signed-out, hangs or
# lingering (it answers, and leaves a child holding its output; child.txt gets that child's PID).
$star = @{ asked = 0; answer = ''; failAsk = $false }
$ghStandIn = Join-Path ([IO.Path]::GetTempPath()) "herdr-installer-gh-$PID"
# A real directory: the installer reads the installed copy to tell whether it can run on Windows.
$pluginRoot = Join-Path ([IO.Path]::GetTempPath()) "herdr plugin with spaces $PID"
$launcher = Join-Path $pluginRoot 'scripts\plugin.ps1'
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Start-Process { $global:herdrInstallOpened += ($args -join ' ') }

# Tool boundaries only: no downloads, installed plugins, processes or user settings are changed.
function git {
    $global:LASTEXITCODE = 0
    "aaa`trefs/tags/v1.9.0"
    "bbb`trefs/tags/v1.10.0"
    "ccc`trefs/tags/v2.0.0-rc.1"
    "ddd`trefs/tags/remote-v99"
}
function bun {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq '--version') { $state.bunVersion }
    elseif ($args[-1] -eq 'status') { 'running http://127.0.0.1:7317 (pid 1234)'; 'config: none' }
    # the old id's stop: where it was told to look for its server's pid
    # (a server started by hand from the checkout is found only without one)
    elseif ($args[-1] -eq 'stop' -and $args[0] -like '*legacy root*') {
        $state.stopStateDirs += "$env:HERDR_PLUGIN_STATE_DIR"
        if ($state.handStarted -and $env:HERDR_PLUGIN_STATE_DIR) { 'herdr web ui is not running' } else { 'stopped herdr web ui (pid 1234)' }
    }
    else { throw "Unexpected Bun command: $args" }
}
function herdr {
    $global:LASTEXITCODE = 0
    switch ($args -join ' ') {
        '--version' { 'herdr 0.9.3' }
        'plugin list --json' {
            $plugins = @()
            if ($state.installed) { $plugins = @(@{ plugin_id = $state.installedId; plugin_root = $pluginRoot }) }
            if ($state.legacyInstalled) { $plugins += @{ plugin_id = 'devswha.herdr-web-ui'; plugin_root = (Join-Path $ghStandIn 'legacy root') } }
            @{ result = @{ plugins = $plugins } } | ConvertTo-Json -Depth 4 -Compress
        }
        'status server --json' { @{ running = $state.running } | ConvertTo-Json -Compress }
        'plugin action invoke devswha.ovis.start-windows' { $state.started = $true; '{}' }
        'plugin action invoke devswha.herdr-web-ui.start-windows' { $state.started = $true; $state.startedLegacy = $true; '{}' }
        'plugin uninstall devswha.ovis' { $state.installed = $false; $state.uninstalls++; 'Uninstalled' }
        'plugin uninstall devswha.herdr-web-ui' { $state.legacyInstalled = $false; 'Uninstalled' }
        'plugin config-dir devswha.ovis' { Join-Path $ghStandIn 'config\devswha.ovis' }
        'plugin config-dir devswha.herdr-web-ui' { Join-Path $ghStandIn 'config\devswha.herdr-web-ui' }
        default {
            if ($args[0] -eq 'plugin' -and $args[1] -eq 'install') {
                if ($state.failInstall) { $global:LASTEXITCODE = 1; return }
                # under the id the ref's manifest names
                $state.installed = $true; $state.installs++; $state.ref = $args[4]; $state.installedId = $state.refId
                Remove-Item -LiteralPath $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
                New-Item -ItemType Directory -Force -Path (Split-Path $launcher) | Out-Null
                if ($state.windowsRelease) { Set-Content -LiteralPath $launcher -Value '' }
                'Installed Ovis'
            } else { throw "Unexpected herdr command: $args" }
        }
    }
}
function Invoke-WebRequest {
    # the manifest of the ref being installed: what its id is, or a network that blocks the host
    if ("$($args[-1])" -like 'https://raw.githubusercontent.com/devswha/ovis/*/herdr-plugin.toml') {
        if ($state.manifestBlocked) { throw 'Unable to connect to the remote server' }
        return @{ Content = "name = `"Ovis`"`nid = `"$($state.refId)`"" }
    }
    # herdr's installer, as the stand-in the test wrote: -OutFile is the last argument
    if ($args[0] -eq 'https://herdr.dev/install.cmd') { Set-Content -LiteralPath $args[-1] -Value $state.herdrInstaller -Encoding Ascii; return }
    if ($args[0] -ne 'https://bun.sh/install.ps1') { throw "Unexpected download: $args" }
    if ($state.failBun) { return @{ Content = 'param($Version)' } }
    # as Bun's installer does: the session is left with the user's PATH and nothing of the machine's
    @{ Content = 'param($Version) $state.bunVersion = $Version; $env:PATH = "C:\Users\someone\.bun\bin"' }
}

try {
    New-Item -ItemType Directory -Force -Path $ghStandIn | Out-Null
    Set-Content -LiteralPath (Join-Path $ghStandIn 'gh.cmd') -Encoding Ascii -Value @'
@echo off
echo %*>>"%~dp0calls.txt"
set /p mode=<"%~dp0mode.txt"
echo %* | findstr /C:"--method PUT" >nul
if not errorlevel 1 goto star
if "%mode%"=="starred" goto starred
if "%mode%"=="hangs" goto hangs
if "%mode%"=="signed-out" goto signedout
if "%mode%"=="upstream" goto upstream
if "%mode%"=="lingering" goto lingering
echo HTTP/2.0 404 Not Found
echo gh: Not Found (HTTP 404) 1>&2
exit /b 1
:starred
echo HTTP/2.0 204 No Content
exit /b 0
:hangs
ping -n 16 127.0.0.1 >nul
exit /b 0
:signedout
echo To get started with GitHub CLI, please run:  gh auth login 1>&2
exit /b 4
:lingering
powershell -NoProfile -Command "(Start-Process ping -ArgumentList '-n','47','127.0.0.1' -NoNewWindow -PassThru).Id | Set-Content -Encoding Ascii '%~dp0child.txt'"
echo HTTP/2.0 404 Not Found
exit /b 1
:upstream
echo HTTP/2.0 500 Internal Server Error
echo gh: upstream answered HTTP 404 (HTTP 500) 1>&2
exit /b 1
:star
if "%mode%"=="refuses" goto refused
echo HTTP/2.0 204 No Content
exit /b 0
:refused
echo HTTP/2.0 404 Not Found
echo gh: Not Found (HTTP 404) 1>&2
exit /b 1
'@
    $env:PATH = "$ghStandIn;$env:PATH"
    $ghCalls = Join-Path $ghStandIn 'calls.txt'
    # a first install with this gh; then what the installer said, and how often it starred
    $firstInstall = {
        param([string]$Gh, [string]$Source)
        $state.installed = $false; $star.asked = 0
        Set-Content -LiteralPath (Join-Path $ghStandIn 'mode.txt') -Encoding Ascii -Value $Gh
        Remove-Item -LiteralPath $ghCalls -Force -ErrorAction SilentlyContinue
        if ($Source) { Invoke-Expression $Source 6>&1 | Out-String } else { & $installer -Ref '' 6>&1 | Out-String }
    }
    $given = { @(Get-Content -LiteralPath $ghCalls -ErrorAction SilentlyContinue | Where-Object { $_ -match '--method PUT' }).Count }
    # the status read: the installer's own launcher must reach the stand-in, or a wrong launcher would pass as "already starred"
    $read = { @(Get-Content -LiteralPath $ghCalls -ErrorAction SilentlyContinue | Where-Object { $_ -match 'user/starred' -and $_ -notmatch '--method PUT' }).Count }
    Set-Content -LiteralPath (Join-Path $ghStandIn 'mode.txt') -Encoding Ascii -Value 'signed-out'

    & $installer -Ref ''
    Assert ($state.installed -and $state.ref -eq 'v1.10.0' -and $state.started) 'Install must choose the highest stable release and start a running server'
    & $installer -Ref ''
    Assert ($state.installs -eq 1) 'Rerun must preserve the installed plugin'
    & {
        $ErrorActionPreference = 'Continue'
        Invoke-Expression (Get-Content -Raw $installer)
        Assert ($ErrorActionPreference -eq 'Continue') 'The one-line installer must preserve the caller error preference'
        Assert (-not (Test-Path Function:\Run-Tool)) 'The one-line installer must keep helper functions in its own scope'
    }

    $state.bunVersion = '1.3.0'
    & $installer -Ref ''
    Assert ($state.bunVersion -eq '1.4.2') 'An old Bun must be updated through its installer'
    Assert ($env:PATH.EndsWith($originalPath)) "Bun's installer must not leave the session without the machine PATH"
    $state.bunVersion = '1.3.0'; $state.failBun = $true
    $failed = $false
    try { & $installer -Ref '' } catch { $failed = $_.Exception.Message -match 'Needs Bun' }
    Assert $failed 'An unsuccessful Bun bootstrap must stop installation'
    $state.bunVersion = '1.4.2'; $state.failBun = $false

    $state.installed = $false; $state.running = $false; $state.started = $false
    & $installer -Ref 'feat/windows-install'
    Assert ($state.ref -eq 'feat/windows-install' -and -not $state.started) 'Explicit ref must install without starting herdr'

    $state.installed = $false; $state.failInstall = $true; $state.started = $false
    $failed = $false
    try { & $installer -Ref 'broken' } catch { $failed = $_.Exception.Message -match 'herdr failed' }
    Assert ($failed -and -not $state.started) 'A failed native command must stop installation'

    # A copy from a release without Windows support: installed, listed, and unable to start.
    $state.failInstall = $false; $state.running = $true; $state.installed = $false; $state.windowsRelease = $false
    $failed = $false
    try { & $installer -Ref '' } catch { $failed = $_.Exception.Message -match 'does not support Windows yet' }
    Assert ($failed -and -not $state.started) 'A release without Windows support must not be reported as installed'
    $state.windowsRelease = $true; $installs = $state.installs
    & $installer -Ref ''
    Assert ($state.uninstalls -eq 1 -and $state.installs -eq $installs + 1 -and $state.started) 'A copy without Windows support must be replaced and started'
    Write-Host 'PASS native installer release selection, rerun, Bun bootstrap, explicit ref, stopped herdr, install failure and a copy without Windows support'

    # Releases up to 0.4.13 name the plugin by its old id: told by the manifest, or by the version when it cannot be read.
    foreach ($blocked in $false, $true) {
        $state.installed = $false; $state.started = $false; $state.startedLegacy = $false
        $state.refId = 'devswha.herdr-web-ui'; $state.manifestBlocked = $blocked
        & $installer -Ref 'v0.4.13'
        Assert ($state.installedId -eq 'devswha.herdr-web-ui' -and $state.startedLegacy) "A release that names the old id must install and start under it (manifest blocked: $blocked)"
    }
    $state.installed = $false; $state.started = $false; $state.refId = 'devswha.ovis'; $state.manifestBlocked = $false
    Write-Host 'PASS a release from before the rename installs under its old id'

    # An install under the old id moves to the new one. Its server is stopped with the state dir herdr hands the
    # plugin, where a release from before 0.4.13 keeps its pid: told nothing, that stop looks in ~/.local/state,
    # finds no server, and the one that outlived herdr keeps the old checkout open for the uninstall.
    $savedXdg = $env:XDG_STATE_HOME; $savedPluginState = $env:HERDR_PLUGIN_STATE_DIR
    try {
        Remove-Item Env:\HERDR_PLUGIN_STATE_DIR -ErrorAction SilentlyContinue
        $xdgState = Join-Path $ghStandIn 'xdg state'
        foreach ($xdg in $null, $xdgState) {
            if ($xdg) { $env:XDG_STATE_HOME = $xdg } else { Remove-Item Env:\XDG_STATE_HOME -ErrorAction SilentlyContinue }
            $state.installed = $false; $state.legacyInstalled = $true; $state.stopStateDirs = @(); $state.started = $false
            & $installer -Ref ''
            $expected = Join-Path $(if ($xdg) { $xdg } else { $env:LOCALAPPDATA }) 'herdr\plugins\devswha.herdr-web-ui'
            Assert ($state.stopStateDirs.Count -eq 1 -and $state.stopStateDirs[0] -eq $expected) "The old id's stop must look for its pid where herdr keeps the plugin's state ($expected), not: $($state.stopStateDirs -join ', ')"
            Assert (-not $state.legacyInstalled -and $state.installedId -eq 'devswha.ovis' -and $state.started) 'An install under the old id must move to the new id and start'
            Assert ($null -eq $env:HERDR_PLUGIN_STATE_DIR) 'The state dir given to the old stop must not stay set for later commands'
        }
        # a server started by hand from the old checkout: not found through herdr's dir, so the stop asks again without it
        $state.installed = $false; $state.legacyInstalled = $true; $state.stopStateDirs = @(); $state.handStarted = $true
        & $installer -Ref ''
        Assert ($state.stopStateDirs.Count -eq 2 -and $state.stopStateDirs[0] -and -not $state.stopStateDirs[1]) "A stop that found no server through herdr's dir must ask once more without it: $($state.stopStateDirs -join ' | ')"
        $state.handStarted = $false
    } finally {
        foreach ($pair in @(@('XDG_STATE_HOME', $savedXdg), @('HERDR_PLUGIN_STATE_DIR', $savedPluginState))) {
            if ($null -eq $pair[1]) { Remove-Item "Env:$($pair[0])" -ErrorAction SilentlyContinue }
            else { Set-Item "Env:$($pair[0])" $pair[1] }
        }
        $state.legacyInstalled = $false
    }
    Write-Host 'PASS an install under the old id stops its server through the state dir herdr gives it, and moves'

    # Browser opening is covered through a stand-in; this harness never starts a real browser.
    $savedCi = $env:CI; $savedNoOpen = $env:OVIS_NO_OPEN; $savedSsh = $env:SSH_CONNECTION
    try {
        Remove-Item Env:\CI, Env:\OVIS_NO_OPEN, Env:\SSH_CONNECTION -ErrorAction SilentlyContinue
        $state.installed = $false; $state.running = $true; $global:herdrInstallOpened = @()
        $freshOutput = & $installer -Ref 'test' 6>&1 | Out-String
        Assert ($global:herdrInstallOpened.Count -eq 1 -and $global:herdrInstallOpened[0] -eq 'http://127.0.0.1:7317') 'A fresh install must open the loopback origin exactly once'
        Assert ($freshOutput -match 'opened http://127\.0\.0\.1:7317.*click Install') 'A fresh install must explain where to click Install'

        $global:herdrInstallOpened = @()
        $rerunOutput = & $installer -Ref 'test' 6>&1 | Out-String
        Assert ($global:herdrInstallOpened.Count -eq 0 -and $rerunOutput -notmatch 'opened ') 'A rerun must not open the app'

        foreach ($gate in 'OVIS_NO_OPEN', 'CI', 'SSH_CONNECTION') {
            $state.installed = $false; $global:herdrInstallOpened = @()
            Set-Item "Env:$gate" '1'
            $output = & $installer -Ref 'test' 6>&1 | Out-String
            Assert ($global:herdrInstallOpened.Count -eq 0) "$gate must prevent opening"
            if ($gate -eq 'SSH_CONNECTION') {
                Assert ($output -match 'ssh -L 7317:127\.0\.0\.1:7317' -and $output -match 'Tailscale') 'SSH guidance must include the tunnel command and Tailscale pointer'
            }
            Remove-Item "Env:$gate" -ErrorAction SilentlyContinue
        }
        $state.installed = $false; $state.running = $false; $global:herdrInstallOpened = @()
        $stoppedOutput = & $installer -Ref 'test' 6>&1 | Out-String
        Assert ($global:herdrInstallOpened.Count -eq 0 -and $stoppedOutput -notmatch 'opened ') 'A fresh install must not open the app when herdr is stopped'
        $state.running = $true
        Write-Host 'PASS Windows app opening: fresh install, rerun, OVIS_NO_OPEN, SSH tunnel and Tailscale, and CI'
    } finally {
        foreach ($pair in @(@('CI', $savedCi), @('OVIS_NO_OPEN', $savedNoOpen), @('SSH_CONNECTION', $savedSsh))) {
            if ($null -eq $pair[1]) { Remove-Item "Env:$($pair[0])" -ErrorAction SilentlyContinue }
            else { Set-Item "Env:$($pair[0])" $pair[1] }
        }
        $global:herdrInstallOpened = @()
    }

    # The star: mentioned once on a first install, asked only at a terminal, given only on "y".
    $mention = 'a GitHub star helps other herdr users find it'
    $question = 'star it now with the GitHub account'
    $said = & $firstInstall 'starred'
    Assert ($said -notmatch $mention -and $star.asked -eq 0 -and (& $read) -eq 1 -and (& $given) -eq 0) "An account that already starred must hear nothing of it, after one status read: $said"
    $said = & $firstInstall 'signed-out'
    Assert ($said -match $mention -and $said -notmatch $question -and (& $given) -eq 0) "Without a gh sign-in the link is all there is: $said"
    $newInstall = $true
    $said = & $installer -Ref '' 6>&1 | Out-String
    Remove-Variable newInstall
    Assert ($said -notmatch $mention) "A rerun must not mention the star, whatever the caller's variables hold: $said"
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $said = & $firstInstall 'hangs'
    Assert ($said -match $mention -and $said -notmatch $question -and $clock.Elapsed.TotalSeconds -lt 14) "A gh that does not answer must be left after 10 seconds, with the link: $($clock.Elapsed.TotalSeconds) s, $said"

    # The installer as it is, where this test runs: CI has no terminal, and a developer's terminal is told it is CI.
    $ci = $env:CI; $env:CI = 'true'
    try { $said = & $firstInstall 'not' } finally { $env:CI = $ci }
    Assert ($said -match $mention -and $said -notmatch $question -and $star.asked -eq 0 -and (& $given) -eq 0) "An agent or a script must get the link and no question: $said"

    # Whether somebody is at a terminal is what a test host cannot be: the installer's own text, with those two answers given.
    $source = Get-Content -Raw $installer
    $decision = 'if ($newInstall) {'
    Assert (($source -split [regex]::Escape($decision)).Count -eq 2) 'The installer must decide once, after its helpers, whether this was a first install'
    # The installer defines its own Read-Answer above the decision, so the test's stands in after it: the answer
    # given here, or null where nobody is at the terminal and the installer's own wait is what ended.
    $answering = 'function Read-Answer { $star.asked++; if ($star.failAsk) { throw "Read-Answer has no console to read from" }; $star.answer }'
    $atTerminal = $source.Replace($decision, "function Test-Terminal { `$true }; $answering; $decision")
    $nobodyThere = $source.Replace($decision, "function Test-Terminal { `$true }; function Read-Answer { `$null }; $decision")
    $star.answer = 'y'
    $said = & $firstInstall 'not' $nobodyThere
    Assert ($said -match $question -and $star.asked -eq 0 -and (& $given) -eq 0) "A question nobody answers must be left without a star: $said"
    foreach ($gh in 'upstream', 'signed-out') {
        $said = & $firstInstall $gh $atTerminal
        Assert ($said -match $mention -and $said -notmatch $question -and $star.asked -eq 0) "Only GitHub's own 404 is a reason to ask, not ${gh}: $said"
    }
    foreach ($answer in '', 'n', 'yy') {
        $star.answer = $answer
        $said = & $firstInstall 'not' $atTerminal
        Assert ($said -match $question -and $star.asked -eq 1 -and (& $given) -eq 0) "The answer '$answer' must not star: $said"
    }
    $star.answer = 'y'
    $said = & $firstInstall 'not' $atTerminal
    Assert ($star.asked -eq 1 -and (& $given) -eq 1 -and $said -match 'starred\. Thank you') "A yes must star once: $said"
    $said = & $firstInstall 'refuses' $atTerminal
    Assert ($said -match 'could not star it' -and $state.installed) "A star gh refuses must be said, not thrown: $said"
    $star.failAsk = $true
    $said = & $firstInstall 'not' $atTerminal
    $star.failAsk = $false
    Assert ($state.installed -and $star.asked -eq 1 -and (& $given) -eq 0) "A question that cannot be asked must not fail the install: $said"
    & $firstInstall 'signed-out' | Out-Null
    Write-Host 'PASS star: silent when starred or on a rerun, a link without gh, an answer or a terminal, asked once at a terminal and given only on yes'

    # A gh that leaves a child holding its output: the call ends on its deadline and the child ends with it.
    # Invoke-GhApi alone, from the installer's own text, so that only what it starts is looked at.
    $parsed = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $installer).Path, [ref]$null, [ref]$null)
    $ghApi = $parsed.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-GhApi' }, $true)
    Assert ($null -ne $ghApi) 'The installer must define Invoke-GhApi'
    Invoke-Expression $ghApi.Extent.Text
    Set-Content -LiteralPath (Join-Path $ghStandIn 'mode.txt') -Encoding Ascii -Value 'lingering'
    $childFile = Join-Path $ghStandIn 'child.txt'
    Remove-Item -LiteralPath $childFile -Force -ErrorAction SilentlyContinue
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $answer = Invoke-GhApi 'user/starred/devswha/ovis'
    $elapsed = $clock.Elapsed.TotalSeconds
    $childPid = [int](Get-Content -LiteralPath $childFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    Assert ($childPid -gt 0) 'control: the lingering stand-in must have started its child and named its PID'
    Assert ($null -eq $answer -and $elapsed -lt 15) "control: a gh whose output stays open must be left after its deadline, with no answer: $elapsed s"
    $child = Get-Process -Id $childPid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'PING'
    $left = $child -and -not $child.WaitForExit(5000)
    if ($left) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
    Assert (-not $left) "regression (fails on main): the child gh left holding its output (PID $childPid) must not outlive the call"
    Write-Host "PASS gh deadline: a child of gh that holds its output ends with the call (PID $childPid, $([math]::Round($elapsed, 1)) s)"

    # A native shim starts its output-holding child as its first action, without a PowerShell startup delay.
    # At the assignment boundary, force the old runnable launcher to reach child-ready before proceeding.
    # The fixed launcher must still be suspended there. The same assertion is run against both launches.
    $immediate = Join-Path $ghStandIn 'immediate shim'
    New-Item -ItemType Directory -Path $immediate | Out-Null
    Add-Type -OutputAssembly (Join-Path $immediate 'gh.exe') -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class ImmediateGh {
    public static void Main() {
        Process child = Process.Start(new ProcessStartInfo("ping.exe", "-n 47 127.0.0.1") { UseShellExecute = false });
        File.WriteAllText(Environment.GetEnvironmentVariable("HERDR_TEST_GH_CHILD"), child.Id.ToString());
        using (EventWaitHandle ready = EventWaitHandle.OpenExisting(Environment.GetEnvironmentVariable("HERDR_TEST_GH_READY"))) ready.Set();
        Console.WriteLine("HTTP/2.0 404 Not Found");
        Console.Error.WriteLine("gh: Not Found (HTTP 404)");
        Environment.ExitCode = 1;
    }
}
'@
    $assignment = '[Ovis.GhJob]::Assign($job, $process.Handle)'
    $orderedSource = $ghApi.Extent.Text.Replace("`r`n", "`n").Replace($assignment, '(Assign-TestGhJob $job $process)')
    Assert ($orderedSource -ne $ghApi.Extent.Text) 'control: interpose at the real job assignment boundary'
    function Assign-TestGhJob($Job, $Process) {
        if ($Process -is [Diagnostics.Process]) {
            Assert ($ready.WaitOne(5000)) 'control: the runnable shim must reach child-ready before assignment'
        }
        Assert (-not $ready.WaitOne(0)) 'regression: shim ran before job assignment'
        [Ovis.GhJob]::Assign($Job, $Process.Handle)
    }
    $suspendedLaunch = @'
        if ($job -ne [IntPtr]::Zero) {
            $process = [Ovis.GhJob]::StartSuspended($start.FileName, $start.Arguments)
            if (-not (Assign-TestGhJob $job $process)) {
                $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero
            }
            $process.Resume()
        } else {
            $process = [Diagnostics.Process]::Start($start)
        }
'@
    $runnableLaunch = @'
        $process = [Diagnostics.Process]::Start($start)
        if ($job -ne [IntPtr]::Zero -and -not (Assign-TestGhJob $job $process)) {
            $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero
        }
'@
    # Scratch-source reversion of exactly the pre-fix runnable Start/Assign ordering; no repository file changes.
    $runnableSource = $orderedSource.Replace($suspendedLaunch.Replace("`r`n", "`n"), $runnableLaunch)
    $path = $env:PATH
    $oldReady = $env:HERDR_TEST_GH_READY; $oldChild = $env:HERDR_TEST_GH_CHILD
    try {
        $env:PATH = "$immediate;$path"
        foreach ($case in @(
            @{ name = 'reverted'; source = $runnableSource },
            @{ name = 'fixed'; source = $orderedSource }
        )) {
            $env:HERDR_TEST_GH_READY = "Local\herdr-gh-ready-$([Guid]::NewGuid())"
            $env:HERDR_TEST_GH_CHILD = Join-Path $immediate 'child.txt'
            Remove-Item -LiteralPath $env:HERDR_TEST_GH_CHILD -Force -ErrorAction SilentlyContinue
            $ready = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $env:HERDR_TEST_GH_READY)
            $failure = ''
            try {
                Invoke-Expression $case.source
                $clock = [Diagnostics.Stopwatch]::StartNew()
                $answer = Invoke-GhApi 'user/starred/devswha/ovis'
                Assert ($null -eq $answer -and $clock.Elapsed.TotalSeconds -lt 15) 'regression: immediate child must not keep the call waiting past its deadline'
                Assert ($ready.WaitOne(0)) 'control: the resumed shim must have started its child'
                $childPid = [int](Get-Content -LiteralPath $env:HERDR_TEST_GH_CHILD)
                $child = Get-Process -Id $childPid -ErrorAction SilentlyContinue
                Assert (-not $child -or $child.WaitForExit(5000)) 'regression: immediate child must end with the assigned job'
            } catch { $failure = $_.Exception.Message } finally {
                $childPid = [int](Get-Content -LiteralPath $env:HERDR_TEST_GH_CHILD -ErrorAction SilentlyContinue | Select-Object -First 1)
                if ($childPid -gt 0) {
                    Get-Process -Id $childPid -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'PING' |
                        Stop-Process -Force -ErrorAction SilentlyContinue
                }
                $ready.Dispose()
            }
            if ($case.name -eq 'reverted') {
                Assert ($failure -eq 'regression: shim ran before job assignment') "The reverted launch must fail the ordering assertion, not another error: $failure"
                Write-Host "PASS gh ordering negative control: reverted launch 0 pass, 1 fail ($failure)"
            } else {
                Assert (-not $failure) "The suspended launch must pass the same ordering and child cleanup test: $failure"
                Write-Host 'PASS gh ordering: suspended launch 1 pass, 0 fail; immediate child ends with its job'
            }
        }
    } finally {
        $env:PATH = $path
        $env:HERDR_TEST_GH_READY = $oldReady; $env:HERDR_TEST_GH_CHILD = $oldChild
    }

    # A PC without herdr: its installer is a stand-in .cmd, and nothing of this PC's own herdr is in reach.
    $scratch = Join-Path ([IO.Path]::GetTempPath()) "herdr-installer-test-$PID"
    New-Item -ItemType Directory -Force -Path $scratch | Out-Null
    $runs = Join-Path $scratch 'runs.txt'
    $marker = Join-Path $scratch 'second-run'
    $herdrStandIn = ${function:herdr}
    Remove-Item Function:\herdr
    $env:PATH = "$env:SystemRoot\System32"; $env:LOCALAPPDATA = $scratch; $env:USERPROFILE = $scratch
    Assert (-not (Get-Command herdr -ErrorAction SilentlyContinue)) 'The herdr installer cases need a session without herdr'
    $slow = 'echo curl: (28) Operation too slow. Less than 1024 bytes/sec transferred the last 30 seconds 1>&2'
    $attempts = { @(Get-Content -LiteralPath $runs -ErrorAction SilentlyContinue).Count }

    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`n$slow`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'could not be downloaded' -and (& $attempts) -eq 2) "A download that fails twice must be tried twice and named as a download: $message"

    Remove-Item -LiteralPath $runs -Force
    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -match 'security software' -and (& $attempts) -eq 1) "A stop without a download error must not be retried: $message"

    # The second try succeeds: the script goes on to ask herdr its version, and this session has none.
    Remove-Item -LiteralPath $runs -Force
    $state.herdrInstaller = "@echo off`r`necho run>>`"$runs`"`r`nif exist `"$marker`" exit /b 0`r`necho.>`"$marker`"`r`n$slow`r`nexit /b 1"
    $message = ''
    try { & $installer -Ref '' } catch { $message = $_.Exception.Message }
    Assert ($message -and $message -notmatch 'could not be downloaded|did not finish' -and (& $attempts) -eq 2) "A download that succeeds on the second try must carry on: $message"
    Write-Host 'PASS herdr installer: a failed download is retried once and named, a silent stop is not retried'
} finally {
    $env:PATH = $originalPath
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:USERPROFILE = $originalUserProfile
    if ($herdrStandIn) { Set-Item Function:\herdr $herdrStandIn }
    if ($scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $ghStandIn -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pluginRoot -Recurse -Force -ErrorAction SilentlyContinue
}
