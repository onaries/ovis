# Native Windows install: irm https://ovis.sh/install.ps1 | iex
# Installs herdr when missing, then the release's compiled server into %LOCALAPPDATA%\ovis: ovis-server.exe and the
# built client, taken only once the release's ovis-server.json carries a valid signature by the key pinned below
# ($releasePublicKey) and each file has the size and SHA-256 it names, linked into herdr as a plugin that runs it.
# No Bun is installed. OVIS_FROM_SOURCE=1, a branch (-Ref / OVIS_REF), a plugin installed from source, or a release
# from before the compiled server install from source instead (Bun, and herdr's plugin checkout).
# OVIS_RELEASES_URL names another place for releases: https://, or a file:// folder laid out as GitHub's.
param([string]$Ref = $(if ($env:OVIS_REF) { $env:OVIS_REF } else { $env:HERDR_WEB_UI_REF }))

& {
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'Ovis supports Windows x64. Use install.sh on Linux or macOS.'
}

function Run-Tool([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Tool failed (exit $LASTEXITCODE). Fix the error above and run this again." }
}
function Run-HerdrInstaller([string]$Installer) {
    # Its errors join its output, so a failed download can be told from a silent stop. Under Stop,
    # Windows PowerShell would end this script at the first line curl writes to stderr.
    $ErrorActionPreference = 'Continue'
    & $Installer 2>&1 | ForEach-Object { $line = "$_"; Write-Host $line; $line }
}

# The official installers keep these user-local directories on PATH for future terminals.
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:LOCALAPPDATA\Programs\Herdr\bin;$env:PATH"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Install Git for Windows (https://git-scm.com/download/win), then run this again.'
}
if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) {
    # install.sh runs Ovis on herdr-core where there is no herdr; here the plugin runs under herdr,
    # and Settings switches the server to herdr-core afterwards
    if (Get-Command herdr-core, hc -CommandType Application -ErrorAction SilentlyContinue) {
        Write-Host 'Ovis: found herdr-core (hc). Ovis starts on herdr; to show the Herdr app''s terminals, switch in Settings > About > Terminals'
    }
    Write-Host 'Ovis: installing herdr for your user'
    $installer = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName() + '.cmd')
    try {
        Invoke-WebRequest 'https://herdr.dev/install.cmd' -UseBasicParsing -OutFile $installer
        # herdr's installer gives up on a download that stays under 1 KB/s for 30 seconds.
        $download = 'curl: \(\d+\)|Failed to download'
        $output = @(Run-HerdrInstaller $installer)
        if ($LASTEXITCODE -ne 0 -and ($output -match $download)) {
            Write-Host "Ovis: herdr's download did not finish; trying once more"
            $output = @(Run-HerdrInstaller $installer)
        }
        if ($LASTEXITCODE -ne 0) {
            if ($output -match $download) { throw "herdr could not be downloaded: the connection was too slow or was cut off (curl's message is above). Run this again, on another network if it keeps failing, or install herdr from https://herdr.dev first." }
            # Seen stopping without a message of its own on a PC with banking security software.
            throw "herdr's installer did not finish. If it showed no error, security software may have stopped it: install herdr from https://herdr.dev, then run this again."
        }
    } finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
}
$herdrVersion = (Run-Tool herdr @('--version')) -replace '^herdr\s+', '' -replace '-.*$', ''
if ([version]$herdrVersion -lt [version]'0.9.0') {
    throw "Needs herdr 0.9.0 or newer; this is $herdrVersion. Update herdr, restart it, and run this again."
}

$pluginId = 'devswha.ovis'
# the id before the rename: an install under it moves to $pluginId, keeping its config
$legacyId = 'devswha.herdr-web-ui'
function Find-Plugin([string]$Id = $pluginId) {
    (Run-Tool herdr @('plugin', 'list', '--json') | ConvertFrom-Json).result.plugins |
        Where-Object { $_.plugin_id -eq $Id } | Select-Object -First 1
}
# the highest vX.Y.Z tag, as the updater picks it
function Get-LatestRef {
    $latest = Run-Tool git @('ls-remote', '--tags', '--refs', 'https://github.com/devswha/ovis.git', 'v*') |
        ForEach-Object { if ($_ -match 'refs/tags/(v\d+\.\d+\.\d+)$') { $Matches[1] } } |
        Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1
    if (-not $latest) { throw 'Could not find the latest app release on GitHub. Check your connection and run this again.' }
    $latest
}

# The release's compiled server: %LOCALAPPDATA%\ovis\bin is the release that runs (ovis-server.exe, dist\, and the
# manifest and signature it was checked against), and plugin\ is the herdr plugin that runs it.
$ovisHome = Join-Path $env:LOCALAPPDATA 'ovis'
# The public half of the key every release's ovis-server.json is signed with: scripts/server-manifest.ts
# RELEASE_PUBLIC_KEY, which the release jobs check against too. Nothing else can stand in for it.
$releasePublicKey = 'C8+dOD0gpFHoy008ZqHO89vXutaLqlt5uWyIh250OiY='

# Ed25519 verification (RFC 8032, section 5.1.7), which neither Windows PowerShell nor .NET has built in: compiled
# once with Add-Type. It is used only after it accepts RFC 8032's test vector 2 and refuses that signature over
# another message (Test-Ed25519), as install.sh does with the checker it finds.
function Initialize-Ed25519 {
    if ('Ovis.Ed25519' -as [type]) { return }
    $source = @'
using System;
using System.Numerics;
using System.Security.Cryptography;
namespace Ovis {
    public static class Ed25519 {
        static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
        static readonly BigInteger Q = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493");
        static readonly BigInteger D = Mod(-121665 * Inv(121666));
        static readonly BigInteger I = BigInteger.ModPow(2, (P - 1) / 4, P);
        static BigInteger Mod(BigInteger x) { BigInteger r = x % P; return r.Sign < 0 ? r + P : r; }
        static BigInteger Inv(BigInteger x) { return BigInteger.ModPow(Mod(x), P - 2, P); }
        // a little-endian unsigned number: the extra zero byte keeps BigInteger from reading it as negative
        static BigInteger Number(byte[] bytes, int offset, int length) {
            byte[] copy = new byte[length + 1];
            Array.Copy(bytes, offset, copy, 0, length);
            return new BigInteger(copy);
        }
        // points in extended coordinates (X, Y, Z, T), x = X/Z, y = Y/Z, x*y = T/Z
        static BigInteger[] Add(BigInteger[] a, BigInteger[] b) {
            BigInteger A = Mod((a[1] - a[0]) * (b[1] - b[0])), B = Mod((a[1] + a[0]) * (b[1] + b[0]));
            BigInteger C = Mod(2 * a[3] * b[3] * D), E = Mod(2 * a[2] * b[2]);
            BigInteger F = B - A, G = E - C, H = E + C, K = B + A;
            return new BigInteger[] { Mod(F * G), Mod(H * K), Mod(G * H), Mod(F * K) };
        }
        static BigInteger[] Multiply(BigInteger s, BigInteger[] point) {
            BigInteger[] result = { BigInteger.Zero, BigInteger.One, BigInteger.One, BigInteger.Zero };
            while (s > 0) {
                if (!s.IsEven) result = Add(result, point);
                point = Add(point, point);
                s >>= 1;
            }
            return result;
        }
        static BigInteger[] Decode(byte[] bytes, int offset) {
            byte[] copy = new byte[32];
            Array.Copy(bytes, offset, copy, 0, 32);
            int sign = copy[31] >> 7;
            copy[31] &= 0x7f;
            BigInteger y = Number(copy, 0, 32);
            if (y >= P) return null;
            BigInteger y2 = Mod(y * y), x2 = Mod((y2 - 1) * Inv(D * y2 + 1));
            if (x2.IsZero) return sign == 1 ? null : new BigInteger[] { BigInteger.Zero, y, BigInteger.One, BigInteger.Zero };
            BigInteger x = BigInteger.ModPow(x2, (P + 3) / 8, P);
            if (!Mod(x * x - x2).IsZero) x = Mod(x * I);
            if (!Mod(x * x - x2).IsZero) return null;
            if ((x.IsEven ? 0 : 1) != sign) x = P - x;
            return new BigInteger[] { x, y, BigInteger.One, Mod(x * y) };
        }
        public static bool Verify(byte[] publicKey, byte[] message, byte[] signature) {
            if (publicKey == null || message == null || signature == null || publicKey.Length != 32 || signature.Length != 64) return false;
            BigInteger[] a = Decode(publicKey, 0), r = Decode(signature, 0);
            if (a == null || r == null) return false;
            BigInteger s = Number(signature, 32, 32);
            if (s >= Q) return false;
            byte[] encodedBase = new byte[32];
            encodedBase[0] = 0x58;
            for (int i = 1; i < 32; i++) encodedBase[i] = 0x66;
            byte[] input = new byte[64 + message.Length];
            Array.Copy(signature, 0, input, 0, 32);
            Array.Copy(publicKey, 0, input, 32, 32);
            Array.Copy(message, 0, input, 64, message.Length);
            byte[] hash;
            using (SHA512 sha = SHA512.Create()) { hash = sha.ComputeHash(input); }
            BigInteger k = Number(hash, 0, 64) % Q;
            BigInteger[] left = Multiply(s, Decode(encodedBase, 0)), right = Add(r, Multiply(k, a));
            return Mod(left[0] * right[2] - right[0] * left[2]).IsZero && Mod(left[1] * right[2] - right[1] * left[2]).IsZero;
        }
    }
}
'@
    try { Add-Type -TypeDefinition $source -ReferencedAssemblies System.Numerics }
    catch { Add-Type -TypeDefinition $source }
}
function Test-Ed25519([byte[]]$PublicKey, [byte[]]$Message, [byte[]]$Signature) {
    Initialize-Ed25519
    $vectorKey = [Convert]::FromBase64String('PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=')
    $vectorSignature = [Convert]::FromBase64String('kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA==')
    if (-not [Ovis.Ed25519]::Verify($vectorKey, [byte[]](0x72), $vectorSignature) -or [Ovis.Ed25519]::Verify($vectorKey, [byte[]](0x73), $vectorSignature)) {
        throw 'the signature check does not work in this PowerShell'
    }
    [Ovis.Ed25519]::Verify($PublicKey, $Message, $Signature)
}

# Where releases come from: OVIS_RELEASES_URL (https://, or a file:// folder for tests), else GitHub's downloads.
function Get-ReleasesBase {
    $base = if ($env:OVIS_RELEASES_URL) { $env:OVIS_RELEASES_URL.TrimEnd('/') } else { 'https://github.com/devswha/ovis/releases/download' }
    if ($base -notmatch '^https://[^/]' -and $base -notmatch '^file:///') {
        throw "OVIS_RELEASES_URL must be an https:// address or a file:// folder (file:///C:/path); $base is neither"
    }
    $base
}
# The file at $Url into $Path, refused past $Limit bytes and on a redirect off https; $false where there is none.
function Save-ReleaseFile([string]$Url, [string]$Path, [long]$Limit, [string]$Name) {
    $tooLarge = "$Name is larger than the $Limit bytes ovis-server.json names"
    if ($Url -like 'file://*') {
        $source = ([Uri]$Url).LocalPath
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { return $false }
        if ((Get-Item -LiteralPath $source).Length -gt $Limit) { throw $tooLarge }
        Copy-Item -LiteralPath $source -Destination $Path
        return $true
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create($Url)
    $request.UserAgent = 'ovis-install'
    try { $response = $request.GetResponse() }
    catch {
        $failure = $_.Exception
        while ($failure -and -not ($failure -is [Net.WebException])) { $failure = $failure.InnerException }
        if ($failure -and $failure.Response -and [int]$failure.Response.StatusCode -eq 404) { return $false }
        throw "could not download $Url ($($_.Exception.Message))"
    }
    try {
        if ($response.ResponseUri.Scheme -ne 'https') { throw "$Url redirected to $($response.ResponseUri), which is not https" }
        $stream = $response.GetResponseStream()
        $file = [IO.File]::Create($Path)
        try {
            $buffer = New-Object byte[] 65536
            $total = 0
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $read
                if ($total -gt $Limit) { throw $tooLarge }
                $file.Write($buffer, 0, $read)
            }
        } finally { $file.Dispose() }
    } finally { $response.Close() }
    $true
}
# The release's file $Name into $Path, kept only with the name, size and SHA-256 the checked manifest's $Entry gives it
function Save-CheckedFile([string]$At, $Entry, [string]$Name, [string]$Path) {
    if (-not $Entry -or $Entry.file -cne $Name -or "$($Entry.sha256)" -cnotmatch '^[0-9a-f]{64}$' -or -not ($Entry.size -is [int] -or $Entry.size -is [long])) {
        throw "ovis-server.json names no $Name with its SHA-256 and size"
    }
    if (-not (Save-ReleaseFile "$At/$Name" $Path ([long]$Entry.size) $Name)) { throw "$At/$Name does not exist" }
    $size = (Get-Item -LiteralPath $Path).Length
    if ($size -ne $Entry.size) { throw "$Name is $size bytes, not the $($Entry.size) ovis-server.json names" }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($hash -ne $Entry.sha256) { throw "$Name does not match its SHA-256 in ovis-server.json (got $hash)" }
}
# The client archive into $Into, after its listing shows only plain files and folders inside it
function Expand-Client([string]$Archive, [string]$Into) {
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar)) { $tar = 'tar' }
    $names = @(& $tar -tzf $Archive)
    if ($LASTEXITCODE -ne 0) { throw 'could not read ovis-dist.tar.gz' }
    foreach ($name in $names) {
        if ($name -match '^([/\\]|[A-Za-z]:)' -or ($name -split '[/\\]') -contains '..') { throw "ovis-dist.tar.gz holds $name, a path outside its folder" }
    }
    foreach ($line in @(& $tar -tzvf $Archive)) {
        if ($line -and $line -notmatch '^[-d]') { throw 'ovis-dist.tar.gz holds something other than files and folders' }
    }
    New-Item -ItemType Directory -Path $Into | Out-Null
    & $tar -xzf $Archive -C $Into
    if ($LASTEXITCODE -ne 0) { throw 'could not unpack ovis-dist.tar.gz' }
    if (Get-ChildItem -LiteralPath $Into -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'ovis-dist.tar.gz unpacked a link' }
    if (-not (Test-Path -LiteralPath (Join-Path $Into 'index.html'))) { throw 'ovis-dist.tar.gz holds no index.html' }
}
# One install at a time in $ovisHome: .install.lock, a folder New-Item makes or refuses (atomic), holding this
# process's id. Another run waits for it, at most $WaitSeconds, then fails saying who holds it. A lock whose holder is
# gone (no such process, or no pid written for more than a minute) is broken under .install.lock.break, one breaker at
# a time. With three or more installs started at the same instant a narrow race remains (a follow-up).
function Enter-InstallLock([string]$Lock, [int]$WaitSeconds = 600) {
    $breaker = "$Lock.break"
    $waited = 0
    while ($true) {
        # the claim is the pid file, created only where none is (New-Item makes a folder that is there already no
        # error to every caller at once): the folder alone does not exclude
        New-Item -ItemType Directory -Force -Path $Lock -ErrorAction SilentlyContinue | Out-Null
        if (New-ExclusiveFile (Join-Path $Lock 'pid') "$PID") { break }
        $broke = $false
        if (New-ExclusiveFile $breaker "$PID") {
            try {
                $holder = Get-Content -LiteralPath (Join-Path $Lock 'pid') -ErrorAction SilentlyContinue | Select-Object -First 1
                $stale = if ($holder -match '^\d+$') { -not (Get-Process -Id ([int]$holder) -ErrorAction SilentlyContinue) }
                    else { ((Get-Date) - (Get-Item -LiteralPath $Lock -ErrorAction SilentlyContinue).LastWriteTime).TotalSeconds -gt 60 }
                # removed only while it still holds the record judged stale: a fresh holder's lock is never taken
                $now = Get-Content -LiteralPath (Join-Path $Lock 'pid') -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($stale -and "$now" -eq "$holder") { Remove-Item -LiteralPath $Lock -Recurse -Force -ErrorAction SilentlyContinue; $broke = $true }
            } finally { Remove-Item -LiteralPath $breaker -Recurse -Force -ErrorAction SilentlyContinue }
        } elseif (((Get-Date) - (Get-Item -LiteralPath $breaker -ErrorAction SilentlyContinue).LastWriteTime).TotalSeconds -gt 60) {
            Remove-Item -LiteralPath $breaker -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($broke) { continue }
        if ($waited -ge $WaitSeconds) {
            $holder = Get-Content -LiteralPath (Join-Path $Lock 'pid') -ErrorAction SilentlyContinue | Select-Object -First 1
            throw "another install is running in $ovisHome (pid $holder); run this again once it ends. Nothing was changed"
        }
        if ($waited -eq 0) { Write-Host "Ovis: another install is running in $ovisHome; waiting for it" }
        Start-Sleep -Seconds 1
        $waited++
    }
}
# Creates $Path holding $Text only where no file is (CreateNew, one winner); $false when one is there, or it cannot
function New-ExclusiveFile([string]$Path, [string]$Text) {
    try { $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write) } catch { return $false }
    try { $bytes = [Text.Encoding]::ASCII.GetBytes("$Text`r`n"); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Close() }
    return $true
}
function Exit-InstallLock([string]$Lock) {
    $holder = Get-Content -LiteralPath (Join-Path $Lock 'pid') -ErrorAction SilentlyContinue | Select-Object -First 1
    if ("$holder" -eq "$PID") { Remove-Item -LiteralPath $Lock -Recurse -Force -ErrorAction SilentlyContinue }
}
# The release's server of $Version into $ovisHome\bin, holding the install lock (Install-OvisBinaryLocked): a run that
# waited for another finds the version it installed and has nothing to do, or installs its own
function Install-OvisBinary([string]$Version) {
    New-Item -ItemType Directory -Force -Path $ovisHome | Out-Null
    $lock = Join-Path $ovisHome '.install.lock'
    Enter-InstallLock $lock
    try { Install-OvisBinaryLocked $Version } finally { Exit-InstallLock $lock }
}
# The release's server of $Version into $ovisHome\bin, unless it runs there already ($false then). Nothing in bin
# changes before the manifest's signature (by $releasePublicKey), its version, and the size and SHA-256 of the binary
# and the client archive have been checked; then the old bin is moved aside and the checked release moved in. A run
# cut off between those two renames finds bin missing next time and moves the old one back.
function Install-OvisBinaryLocked([string]$Version) {
    $at = "$(Get-ReleasesBase)/v$Version"
    $bin = Join-Path $ovisHome 'bin'
    $releases = Join-Path $ovisHome 'releases'
    New-Item -ItemType Directory -Force -Path $releases | Out-Null
    if (-not (Test-Path -LiteralPath $bin)) {
        $aside = Get-ChildItem -LiteralPath $ovisHome -Directory -Filter 'bin.old-*' | Sort-Object Name | Select-Object -Last 1
        if ($aside) { Rename-Item -LiteralPath $aside.FullName -NewName 'bin' }
    }
    # only the lock's holder makes a stage: one found now was left by a run that died
    Get-ChildItem -LiteralPath $releases -Directory -Force -Filter '.stage-*' | Remove-Item -Recurse -Force
    $exe = Join-Path $bin 'ovis-server.exe'
    try {
        $running = Get-Content -Raw -LiteralPath (Join-Path $bin 'ovis-server.json') | ConvertFrom-Json
        # the client it serves too: one gone missing is installed again
        if ($running.version -eq $Version -and (Get-FileHash -Algorithm SHA256 -LiteralPath $exe).Hash.ToLowerInvariant() -eq $running.assets.'windows-x64'.sha256 -and (Test-Path -LiteralPath (Join-Path $bin 'dist\index.html'))) {
            Write-Host "Ovis: Ovis $Version is installed already in $ovisHome; nothing to do"
            return $false
        }
    } catch { } # no release of this version runs here yet
    $stage = Join-Path $releases ('.stage-' + [IO.Path]::GetRandomFileName().Replace('.', ''))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $manifestFile = Join-Path $stage 'ovis-server.json'
        $signatureFile = Join-Path $stage 'ovis-server.json.sig'
        if (-not (Save-ReleaseFile "$at/ovis-server.json" $manifestFile 65536 'ovis-server.json')) { throw "$at/ovis-server.json does not exist" }
        if (-not (Save-ReleaseFile "$at/ovis-server.json.sig" $signatureFile 1024 'ovis-server.json.sig')) { throw "$at/ovis-server.json.sig does not exist" }
        $signature = [IO.File]::ReadAllText($signatureFile)
        if ($signature -cnotmatch '^[A-Za-z0-9+/]{86}==\n$') { throw 'ovis-server.json.sig is not one line of base64 holding a signature' }
        if (-not (Test-Ed25519 ([Convert]::FromBase64String($releasePublicKey)) ([IO.File]::ReadAllBytes($manifestFile)) ([Convert]::FromBase64String($signature.TrimEnd("`n"))))) {
            throw "ovis-server.json.sig is not a valid signature of the release's ovis-server.json by the key $releasePublicKey"
        }
        $manifest = [IO.File]::ReadAllText($manifestFile) | ConvertFrom-Json
        if ($manifest.version -cne $Version) { throw "ovis-server.json is for version $($manifest.version), not $Version" }
        if ($manifest.schema -ne 1) { throw 'ovis-server.json is of a schema this installer does not know; a newer install.ps1 reads it' }
        Save-CheckedFile $at $manifest.assets.'windows-x64' 'ovis-server-windows-x64.exe' (Join-Path $stage 'ovis-server.exe')
        $archive = Join-Path $stage 'ovis-dist.tar.gz'
        Save-CheckedFile $at $manifest.dist 'ovis-dist.tar.gz' $archive
        Expand-Client $archive (Join-Path $stage 'dist')
        Remove-Item -LiteralPath $archive
        # checked: the server the old release runs is stopped, since Windows keeps a running program's folder in place
        if (Test-Path -LiteralPath $exe) { try { & $exe plugin stop *> $null } catch { } }
        $aside = 'bin.old-' + [IO.Path]::GetRandomFileName().Replace('.', '')
        if (Test-Path -LiteralPath $bin) { Rename-Item -LiteralPath $bin -NewName $aside }
        try { Move-Item -LiteralPath $stage -Destination $bin }
        catch {
            if (Test-Path -LiteralPath (Join-Path $ovisHome $aside)) { Rename-Item -LiteralPath (Join-Path $ovisHome $aside) -NewName 'bin' }
            throw
        }
        Remove-Item -LiteralPath (Join-Path $ovisHome $aside) -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        throw "$($_.Exception.Message); nothing was changed"
    }
    Write-Host "Ovis: installed Ovis $Version (ovis-server-windows-x64.exe, checked against the signed ovis-server.json) in $ovisHome"
    $true
}
# The plugin herdr links for the binary: run.ps1 hands each command to bin\ovis-server.exe, a start in a hidden
# console of its own, as scripts/plugin.ps1 does, so PowerShell's pipes stay out of the detached server
function Write-OvisPlugin([string]$Version) {
    $dir = Join-Path $ovisHome 'plugin'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $run = @'
# herdr's way into the Ovis that install.ps1 installed: the release's server, as `ovis-server plugin <command>`
param([string]$Command = 'status', [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot '..\bin\ovis-server.exe'
if ($Command -eq 'start') {
    $child = Start-Process -FilePath $exe -ArgumentList 'plugin', 'start' -WindowStyle Hidden -PassThru
    $null = $child.Handle
    $child.WaitForExit()
    if ($child.ExitCode -ne 0) {
        $log = Join-Path $env:HERDR_PLUGIN_STATE_DIR 'server.log'
        $tail = if (Test-Path -LiteralPath $log) { (Get-Content -LiteralPath $log -Tail 15) -join "`n" } else { '(no log)' }
        throw "Could not start Ovis. $log ends with:`n$tail"
    }
    Write-Output 'Ovis started'
    exit 0
}
& $exe plugin $Command @Rest
exit $LASTEXITCODE
'@
    $command = '"powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "run.ps1"'
    $manifest = @"
id = "$pluginId"
name = "Ovis"
version = "$Version"
min_herdr_version = "0.9.0"
description = "Ovis, the browser and phone client for herdr, installed by install.ps1 as the release's compiled server"
platforms = ["windows"]

[[startup]]
command = [$command, "start"]

[[actions]]
id = "start-windows"
title = "Start Ovis"
contexts = ["workspace"]
command = [$command, "start"]

[[actions]]
id = "stop-windows"
title = "Stop Ovis"
contexts = ["workspace"]
command = [$command, "stop"]

[[actions]]
id = "status-windows"
title = "Ovis status"
contexts = ["workspace"]
command = [$command, "status"]

[[panes]]
id = "phone-windows"
title = "Phone setup"
placement = "zoomed"
command = [$command, "phone-setup"]

[[actions]]
id = "phone-windows"
title = "Phone setup"
contexts = ["workspace"]
command = ["herdr", "plugin", "pane", "open", "--plugin", "$pluginId", "--entrypoint", "phone-windows", "--placement", "zoomed", "--focus"]
"@
    Set-Content -LiteralPath (Join-Path $dir 'run.ps1.new') -Value $run -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $dir 'herdr-plugin.toml.new') -Value $manifest -Encoding UTF8
    Move-Item -Force -LiteralPath (Join-Path $dir 'run.ps1.new') -Destination (Join-Path $dir 'run.ps1')
    Move-Item -Force -LiteralPath (Join-Path $dir 'herdr-plugin.toml.new') -Destination (Join-Path $dir 'herdr-plugin.toml')
}

# The release's binary, unless this install is from source: OVIS_FROM_SOURCE=1, a plugin installed from source
# already (herdr's checkout, which Settings > Updates keeps current), a ref that is not a release tag, or a release
# that ships no ovis-server.json yet (one from before the compiled server).
$newInstall = $false
$binaryDone = $false
$ovisPlugin = Join-Path $ovisHome 'plugin'
$listed = Find-Plugin
$fromSource = $env:OVIS_FROM_SOURCE -eq '1' -or (Find-Plugin $legacyId) -or
    ($listed -and -not ($listed.plugin_root -and [IO.Path]::GetFullPath($listed.plugin_root).TrimEnd('\') -ieq [IO.Path]::GetFullPath($ovisPlugin).TrimEnd('\')))
if (-not $fromSource) {
    $releases = Get-ReleasesBase
    $wanted = $Ref
    if (-not $wanted -and $releases -like 'file://*') {
        $wanted = Get-ChildItem -LiteralPath ([Uri]$releases).LocalPath -Directory | Where-Object { $_.Name -match '^v\d+\.\d+\.\d+$' } |
            Sort-Object { [version]$_.Name.Substring(1) } | Select-Object -Last 1 -ExpandProperty Name
    } elseif (-not $wanted) { $wanted = Get-LatestRef }
    if ($wanted -match '^v(\d+\.\d+\.\d+)$') {
        $version = $Matches[1]
        $probe = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
        try {
            $shipped = Save-ReleaseFile "$releases/$wanted/ovis-server.json" $probe 65536 'ovis-server.json'
            # a manifest without a schema is of the shape releases had before this installer (todo 5's): signed, for this
            # version, it ships no compiled server this installer runs, as a release without one; the signature comes first
            if ($shipped -and -not (([IO.File]::ReadAllText($probe) | ConvertFrom-Json).PSObject.Properties.Name -contains 'schema')) {
                $sigFile = "$probe.sig"
                $signature = if (Save-ReleaseFile "$releases/$wanted/ovis-server.json.sig" $sigFile 1024 'ovis-server.json.sig') { [IO.File]::ReadAllText($sigFile) } else { '' }
                Remove-Item -LiteralPath $sigFile -Force -ErrorAction SilentlyContinue
                if ($signature -cnotmatch '^[A-Za-z0-9+/]{86}==\n$' -or -not (Test-Ed25519 ([Convert]::FromBase64String($releasePublicKey)) ([IO.File]::ReadAllBytes($probe)) ([Convert]::FromBase64String($signature.TrimEnd("`n")))) -or
                    (([IO.File]::ReadAllText($probe) | ConvertFrom-Json).version -cne $version)) {
                    throw "$releases/$wanted/ovis-server.json is not signed by the key $releasePublicKey for version $version; nothing was changed"
                }
                Write-Host "Ovis: Ovis $wanted's signed ovis-server.json has the shape from before this installer"
                $shipped = $false
            }
        }
        finally { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
        if ($shipped) {
            $changed = Install-OvisBinary $version
            Write-OvisPlugin $version
            if (-not (Find-Plugin)) {
                Run-Tool herdr @('plugin', 'link', $ovisPlugin) | Out-Null
                $newInstall = $true
            }
            $exe = Join-Path $ovisHome 'bin\ovis-server.exe'
            $server = Run-Tool herdr @('status', 'server', '--json') | ConvertFrom-Json
            if ($server.running) {
                Run-Tool herdr @('plugin', 'action', 'invoke', "$pluginId.start-windows") | Out-Null
                $status = $null
                for ($attempt = 0; $attempt -lt 25; $attempt++) {
                    $status = & $exe plugin status | Where-Object { $_ -match '^running ' } | Select-Object -First 1
                    if ($status) { break }
                    Start-Sleep -Seconds 1
                }
                if (-not $status) { throw "The app did not start within 25 seconds.`nSee: herdr plugin log list" }
                Write-Host $status
                if ($newInstall -and $status) { Write-Host "Ovis: open $([regex]::Match($status, '^running (\S+)').Groups[1].Value) in your browser and click Install in the address bar" }
            } else { Write-Host 'Ovis: starts with herdr. Open a new terminal and run: herdr' }
            Write-Host 'Ovis: open Phone setup in herdr for phone access.'
            $binaryDone = $true
        } else {
            Write-Host "Ovis: Ovis $wanted ships no compiled server, so it is installed from source"
            $Ref = $wanted
        }
    }
}
# From source, as before the compiled server: Bun, and herdr's plugin checkout built by its build steps
if (-not $binaryDone) {
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun -or [version]((Run-Tool bun @('--version')) -replace '-.*$', '') -lt [version]'1.4.0') {
    Write-Host 'Ovis: installing Bun 1.4.2 for your user'
    # The same stable runtime as CI; use Bun's official installer rather than a second downloader.
    # It leaves this session with the user's PATH alone: without the machine's, neither this script nor herdr finds git.
    $path = $env:PATH
    & ([scriptblock]::Create((Invoke-WebRequest 'https://bun.sh/install.ps1' -UseBasicParsing).Content)) -Version '1.4.2'
    $env:PATH = $path
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'Bun did not install. See https://bun.sh.' }
$bunVersion = Run-Tool bun @('--version')
if ([version]($bunVersion -replace '-.*$', '') -lt [version]'1.4.0') { throw "Needs Bun 1.4 or newer; this is $bunVersion." }

# The ref to install is settled before anything moves: a release from before the rename still names
# the plugin by its old id, and installing it cannot move an install to the new one
$move = $true
if (-not (Find-Plugin)) {
    if (-not $Ref) { $Ref = Get-LatestRef }
    # the id the manifest at $Ref names
    $refId = try {
        $manifest = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "https://raw.githubusercontent.com/devswha/ovis/$Ref/herdr-plugin.toml").Content
        if ($manifest -match '(?m)^id\s*=\s*"([^"]+)"') { $Matches[1] }
    } catch { $null }
    # raw.githubusercontent.com can be blocked where github.com is not: a release tag's version tells it too
    if (-not $refId -and $Ref -match '^v(\d+\.\d+\.\d+)$') {
        $refId = if ([version]$Matches[1] -ge [version]'0.4.14') { $pluginId } else { $legacyId }
    }
    # That release (0.4.13 and older) installs, runs and updates under the old id: the move waits for
    # a release that names the new one. With the id unknown (a branch whose manifest cannot be read),
    # an install under the old id is left running, since the ref may not be able to move it.
    if ($refId -eq $legacyId) { $pluginId = $legacyId } elseif (-not $refId) { $move = $false }
}
$legacy = if ($pluginId -ne $legacyId -and $move) { Find-Plugin $legacyId } else { $null }
if (-not $move -and (Find-Plugin $legacyId)) {
    Write-Host "Ovis: could not read the plugin id at $Ref, so the install under $legacyId is left as it is; run this again to move it"
}
if ($legacy) {
    Write-Host "Ovis: moving the installed plugin to its Ovis id; its settings and token come along"
    # stopped first: under both ids, each would start a server on herdr's next start. Its stop is told the
    # state dir herdr hands it (as scripts/plugin-state.ts finds herdr's): run from here without it, a
    # release from before 0.4.13 looks for its pid in ~/.local/state, says it is not running, and its
    # server, which can outlive herdr, keeps the old checkout's files open for the uninstall below
    $herdrState = if ($null -ne $env:XDG_STATE_HOME) { [IO.Path]::Combine($env:XDG_STATE_HOME, 'herdr') }
        elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'herdr' }
        else { Join-Path $env:USERPROFILE 'AppData\Local\herdr' }
    $givenState = $env:HERDR_PLUGIN_STATE_DIR
    $env:HERDR_PLUGIN_STATE_DIR = Join-Path $herdrState "plugins\$legacyId"
    try { $stopped = & bun (Join-Path $legacy.plugin_root 'scripts\plugin.ts') stop }
    finally { $env:HERDR_PLUGIN_STATE_DIR = $givenState }
    # a server started by hand from the checkout keeps its pid in its own dir, which the given one hides
    if ($LASTEXITCODE -eq 0 -and -not ($stopped -match '^stopped ')) { & bun (Join-Path $legacy.plugin_root 'scripts\plugin.ts') stop | Out-Null }
    # removed with its server up, the old checkout would keep serving, and the new id's start would
    # find the port answering and leave it
    if ($LASTEXITCODE -ne 0) { throw "Could not stop the server of the old id, so nothing was moved. Stop it (herdr plugin action invoke $legacyId.stop, or restart herdr), then run this again." }
}
function Test-WindowsPlugin($Plugin) {
    $Plugin.plugin_root -and (Test-Path -LiteralPath (Join-Path $Plugin.plugin_root 'scripts\plugin.ps1'))
}
$plugin = Find-Plugin $pluginId
$newInstall = $false
if ($plugin -and -not (Test-WindowsPlugin $plugin)) {
    # A copy from a release older than Windows support never starts here, so no in-app update reaches it.
    Write-Host 'Ovis: replacing an installed copy that has no Windows support'
    Run-Tool herdr @('plugin', 'uninstall', $pluginId) | Out-Null
    $plugin = $null
}
if (-not $plugin) {
    if (-not $Ref) { $Ref = Get-LatestRef }
    Write-Host "Ovis: installing the plugin at $Ref"
    Run-Tool herdr @('plugin', 'install', 'devswha/ovis', '--ref', $Ref, '--yes')
    $newInstall = $true
    $plugin = Find-Plugin $pluginId
    # the id unknown before the install: the ref may have named the old one
    if (-not $plugin -and -not $move) {
        $pluginId = $legacyId
        $plugin = Find-Plugin $pluginId
    }
    if (-not $plugin.plugin_root) { throw 'herdr does not list the plugin after installing it. See: herdr plugin list' }
    # herdr installs a release without Windows build steps as a success that cannot start.
    if (-not (Test-WindowsPlugin $plugin)) { throw "Ovis $Ref does not support Windows yet. Run this again after the next release." }
} else { Write-Host 'Ovis: already installed; Settings > Updates keeps it current' }
if ($legacy) {
    # herdr keeps a plugin's config by its id: the old id's env files (the token among them) go to the new id's dir unless it has its own
    $oldConfig = Run-Tool herdr @('plugin', 'config-dir', $legacyId)
    $newConfig = Run-Tool herdr @('plugin', 'config-dir', $pluginId)
    if (-not (Test-Path -LiteralPath (Join-Path $newConfig 'env')) -and -not (Test-Path -LiteralPath (Join-Path $newConfig '.env'))) {
        foreach ($name in 'env', '.env') {
            $from = Join-Path $oldConfig $name
            if (Test-Path -LiteralPath $from) {
                New-Item -ItemType Directory -Force -Path $newConfig | Out-Null
                Copy-Item -LiteralPath $from -Destination (Join-Path $newConfig $name)
            }
        }
    }
    Run-Tool herdr @('plugin', 'uninstall', $legacyId) | Out-Null
}

$server = Run-Tool herdr @('status', 'server', '--json') | ConvertFrom-Json
if ($server.running) {
    Run-Tool herdr @('plugin', 'action', 'invoke', "$pluginId.start-windows") | Out-Null
    $script = Join-Path $plugin.plugin_root 'scripts\plugin.ts'
    $ready = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        $status = Run-Tool bun @($script, 'status')
        if ($status -match '^running ') { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        # The start ran inside herdr, so what it said is in herdr's plugin log, not on this terminal.
        $why = ''
        try {
            $failed = (& herdr plugin log list | ConvertFrom-Json).result.logs |
                Where-Object { $_.plugin_id -eq $pluginId -and $_.stderr } | Select-Object -Last 1
            if ($failed) { $why = "`n" + $failed.stderr.Trim() }
        } catch { $why = '' } # the reason is a help, not a step: without it the pointer below still stands
        throw "The app did not start within 25 seconds.$why`nSee: herdr plugin log list"
    }
    Write-Host ($status | Where-Object { $_ -match '^running ' })
    $origin = [regex]::Match(($status | Where-Object { $_ -match '^running ' } | Select-Object -First 1), '^running (\S+)').Groups[1].Value
    $opened = $false
    if ($newInstall -and $origin -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?(?:/|$)' -and
        -not $env:CI -and -not $env:OVIS_NO_OPEN -and -not $env:HERDR_WEB_NO_OPEN -and -not $env:SSH_CONNECTION -and
        [Environment]::UserInteractive) {
        try {
            Start-Process $origin
            $opened = $true
            Write-Host "Ovis: opened $origin in your browser: click Install in the address bar to add the app"
        } catch { }
    }
    if ($newInstall -and -not $opened) {
        if ($env:SSH_CONNECTION) {
            $port = [regex]::Match($origin, ':(\d+)(?:/|$)').Groups[1].Value
            if (-not $port) {
                $scheme = [regex]::Match($origin, '^https?://').Value
                $port = if ($scheme -eq 'https://') { '443' } else { '80' }
            }
            Write-Host "Ovis: from your own computer, run: ssh -L ${port}:127.0.0.1:${port} <this-pc>, then open http://127.0.0.1:${port} and click Install in the address bar"
            Write-Host 'Ovis: Phone setup in herdr shows the Tailscale address when there is one'
        } elseif ($origin -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?(?:/|$)') {
            Write-Host "Ovis: open $origin in your browser and click Install in the address bar"
        } else {
            Write-Host "Ovis: open $origin in your browser"
        }
    }
} else { Write-Host 'Ovis: starts with herdr. Open a new terminal and run: herdr' }
Write-Host 'Ovis: open Phone setup in herdr for phone access.'
}

# One gh api call: gh's exit code and the HTTP status GitHub answered with, or nothing when gh is
# not there or does not answer in 10 seconds. A gh that hangs must not hold up an install that is done:
# the deadline covers its exit and its output both (a child it handed the output to could live on),
# and, when job assignment succeeds, what outlasts it is killed with its children. The job ends with
# the call: a shim's launcher may be gone already, and taskkill /T finds no tree under a PID that exited.
function Invoke-GhApi([string]$Arguments) {
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gh) { return }
    $job = [IntPtr]::Zero
    try {
        if (-not ('Ovis.GhJob' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace Ovis {
    public static class GhJob {
        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits {
            public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters { public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits {
            public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct SecurityAttributes {
            public int Length; public IntPtr Descriptor; public int Inherit;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct StartupInfo {
            public int Size; public string Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInfo { public IntPtr Process, Thread; public int Id, ThreadId; }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
            ref StartupInfo startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(IntPtr process, out int code);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);
        // A job whose processes are all killed when its last handle closes (KILL_ON_JOB_CLOSE).
        public static IntPtr Create() {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return job;
            ExtendedLimits info = new ExtendedLimits();
            info.Basic.LimitFlags = 0x2000;
            if (SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) return job;
            CloseHandle(job);
            return IntPtr.Zero;
        }
        public static bool Assign(IntPtr job, IntPtr process) { return AssignProcessToJobObject(job, process); }
        public sealed class GhProcess : IDisposable {
            public IntPtr Handle { get; private set; }
            public int Id { get; private set; }
            public StreamWriter StandardInput { get; private set; }
            public StreamReader StandardOutput { get; private set; }
            public StreamReader StandardError { get; private set; }
            IntPtr thread;
            internal GhProcess(ProcessInfo info, StreamWriter input, StreamReader output, StreamReader error) {
                Handle = info.Process; thread = info.Thread; Id = info.Id;
                StandardInput = input; StandardOutput = output; StandardError = error;
            }
            public void Resume() {
                if (ResumeThread(thread) == uint.MaxValue) throw new Win32Exception();
                CloseHandle(thread); thread = IntPtr.Zero;
            }
            public bool WaitForExit(int milliseconds) {
                uint result = WaitForSingleObject(Handle, (uint)milliseconds);
                if (result == uint.MaxValue) throw new Win32Exception();
                return result == 0;
            }
            public int ExitCode {
                get { int code; if (!GetExitCodeProcess(Handle, out code)) throw new Win32Exception(); return code; }
            }
            public void Dispose() {
                // An error before Resume must not strand a suspended process, even without a job.
                if (thread != IntPtr.Zero) { TerminateProcess(Handle, 1); CloseHandle(thread); thread = IntPtr.Zero; }
                StandardInput.Dispose();
                foreach (StreamReader reader in new[] { StandardOutput, StandardError }) {
                    try { reader.Dispose(); } catch (InvalidOperationException) { }
                }
                CloseHandle(Handle); Handle = IntPtr.Zero;
            }
        }
        public static GhProcess StartSuspended(string application, string arguments) {
            IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero;
            IntPtr outputWrite = IntPtr.Zero, errorRead = IntPtr.Zero, errorWrite = IntPtr.Zero;
            ProcessInfo info = new ProcessInfo();
            StreamWriter input = null; StreamReader output = null, error = null;
            try {
                SecurityAttributes attributes = new SecurityAttributes();
                attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes)); attributes.Inherit = 1;
                if (!CreatePipe(out inputRead, out inputWrite, ref attributes, 0) ||
                    !CreatePipe(out outputRead, out outputWrite, ref attributes, 0) ||
                    !CreatePipe(out errorRead, out errorWrite, ref attributes, 0) ||
                    !SetHandleInformation(inputWrite, 1, 0) ||
                    !SetHandleInformation(outputRead, 1, 0) ||
                    !SetHandleInformation(errorRead, 1, 0)) throw new Win32Exception();
                StartupInfo startup = new StartupInfo();
                startup.Size = Marshal.SizeOf(typeof(StartupInfo)); startup.Flags = 0x100; // STARTF_USESTDHANDLES
                startup.Input = inputRead; startup.Output = outputWrite; startup.Error = errorWrite;
                // CREATE_NO_WINDOW | CREATE_SUSPENDED: assignment happens before any shim code runs.
                if (!CreateProcess(application, new StringBuilder("\"" + application + "\" " + arguments),
                    IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out info))
                    throw new Win32Exception();
                input = new StreamWriter(new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write));
                inputWrite = IntPtr.Zero;
                output = new StreamReader(new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read), Console.OutputEncoding);
                outputRead = IntPtr.Zero;
                error = new StreamReader(new FileStream(new SafeFileHandle(errorRead, true), FileAccess.Read), Console.OutputEncoding);
                errorRead = IntPtr.Zero;
                return new GhProcess(info, input, output, error);
            } catch {
                if (info.Process != IntPtr.Zero) { TerminateProcess(info.Process, 1); CloseHandle(info.Process); }
                if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
                if (input != null) input.Dispose();
                if (output != null) output.Dispose();
                if (error != null) error.Dispose();
                throw;
            } finally {
                // Only the child keeps the inherited ends; parent ends now belong to the streams.
                foreach (IntPtr handle in new[] { inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite })
                    if (handle != IntPtr.Zero) CloseHandle(handle);
            }
        }
    }
}
'@
        }
        $job = [Ovis.GhJob]::Create()
    } catch { $job = [IntPtr]::Zero } # taskkill fallback cannot find an orphan after its launcher exits
    $start = New-Object Diagnostics.ProcessStartInfo
    $ghArguments = "api --hostname github.com --include $Arguments"
    if ($gh.Path -match '\.(cmd|bat)$') {
        # a shim: the command interpreter runs it, with the path and the arguments as one quoted command
        $start.FileName = $env:ComSpec
        $start.Arguments = "/d /c """"$($gh.Path)"" $ghArguments"""
    } else {
        $start.FileName = $gh.Path
        $start.Arguments = $ghArguments
    }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = $null
    try {
        if ($job -ne [IntPtr]::Zero) {
            $process = [Ovis.GhJob]::StartSuspended($start.FileName, $start.Arguments)
            if (-not [Ovis.GhJob]::Assign($job, $process.Handle)) {
                $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero
            }
            $process.Resume()
        } else {
            $process = [Diagnostics.Process]::Start($start)
        }
        $process.StandardInput.Close()
        $said = $process.StandardOutput.ReadToEndAsync()
        $null = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000) -or -not $said.Wait(2000)) {
            # closing the job kills gh and every process it started, also one whose parent has exited
            if ($job -ne [IntPtr]::Zero) { $null = [Ovis.GhJob]::CloseHandle($job); $job = [IntPtr]::Zero }
            try { & $env:ComSpec /d /c "taskkill /T /F /PID $($process.Id) >nul 2>&1" } catch { }
            return
        }
        $status = ''
        if ($said.Result -match '^HTTP\S* (\d{3})') { $status = $Matches[1] }
        @{ code = $process.ExitCode; status = $status }
    } finally {
        # what gh left running after it answered ends here too
        if ($job -ne [IntPtr]::Zero) { $null = [Ovis.GhJob]::CloseHandle($job) }
        if ($process) {
            # Dispose leaves the pipe readers open on .NET Framework; a reader still busy with its
            # ReadToEndAsync may refuse to close, and then the job has ended the writers already
            foreach ($reader in @($process.StandardOutput, $process.StandardError)) { try { $reader.Close() } catch { } }
            $process.Dispose()
        }
    }
}
# A script that runs this has nobody to answer. A terminal can have nobody at it either (an agent's),
# so the answer is read key by key within 20 seconds in all: what was typed before the question is
# discarded, and a line left unfinished when the time is up is no answer.
function Test-Terminal { -not ($env:CI -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) }
function Read-Answer {
    $Host.UI.RawUI.FlushInputBuffer()
    $until = (Get-Date).AddSeconds(20)
    $answer = ''
    while ((Get-Date) -lt $until) {
        if (-not [Console]::KeyAvailable) { Start-Sleep -Milliseconds 100; continue }
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq [ConsoleKey]::Enter) { Write-Host ''; return $answer }
        if ($key.Key -eq [ConsoleKey]::Backspace) {
            if ($answer.Length -gt 0) { $answer = $answer.Substring(0, $answer.Length - 1); Write-Host -NoNewline "`b `b" }
        } elseif (-not [char]::IsControl($key.KeyChar)) {
            $answer += $key.KeyChar
            Write-Host -NoNewline $key.KeyChar
        }
    }
    Write-Host ''
    return $null
}
# Once, on the first install, and not to an account that already starred (204). It asks only when
# GitHub says the account has not (404), only at a terminal, and stars only on "y".
if ($newInstall) {
    try {
        $starred = Invoke-GhApi 'user/starred/devswha/ovis'
        if (-not $starred -or $starred.status -ne '204') {
            Write-Host ''
            Write-Host 'Ovis: if it helps you, a GitHub star helps other herdr users find it: https://github.com/devswha/ovis'
            if ($starred -and $starred.status -eq '404' -and (Test-Terminal)) {
                Write-Host -NoNewline 'Ovis: star it now with the GitHub account gh is signed in to? [y/N] '
                $answer = Read-Answer
                if ("$answer".Trim() -match '^(y|yes)$') {
                    $given = Invoke-GhApi '--method PUT user/starred/devswha/ovis'
                    if ($given -and $given.code -eq 0) { Write-Host 'Ovis: starred. Thank you!' }
                    else { Write-Host 'Ovis: gh could not star it; the page above can' }
                }
            }
        }
    } catch { } # the install is done by now: a question that cannot be asked must not fail it
}
}
