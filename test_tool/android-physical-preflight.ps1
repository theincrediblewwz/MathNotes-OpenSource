param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$Serial,
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

function Resolve-AdbPath {
    foreach ($root in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME)) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        $candidate = Join-Path $root "platform-tools\adb.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command adb -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "ADB_NOT_FOUND: set ANDROID_SDK_ROOT or ANDROID_HOME"
}

function Invoke-Adb([string[]]$Arguments) {
    $lines = & $script:Adb @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "ADB_FAILED: $($lines -join ' ')"
    }
    return ($lines -join "`n").Trim()
}

function Redact-Serial([string]$Value) {
    if ($Value.Length -le 4) { return "****" }
    return ("*" * [Math]::Min(8, $Value.Length - 4)) + $Value.Substring($Value.Length - 4)
}

try {
    $script:Adb = Resolve-AdbPath
    $connected = @()
    foreach ($line in (& $script:Adb devices)) {
        if ($line -match '^([^\s]+)\s+device$') { $connected += $Matches[1] }
    }
    if ([string]::IsNullOrWhiteSpace($Serial)) {
        if ($connected.Count -ne 1) {
            throw "DEVICE_SELECTION_REQUIRED: connect exactly one device or pass -Serial"
        }
        $Serial = $connected[0]
    } elseif ($connected -notcontains $Serial) {
        throw "DEVICE_NOT_READY: selected serial is not connected and authorized"
    }

    $qemu = Invoke-Adb @('-s', $Serial, 'shell', 'getprop', 'ro.kernel.qemu')
    $isEmulator = $Serial.StartsWith('emulator-') -or $qemu -eq '1'
    if ($isEmulator) {
        [Console]::Error.WriteLine(
            "PHYSICAL_DEVICE_REQUIRED: selected target is an emulator ($((Redact-Serial $Serial)))"
        )
        exit 2
    }

    $bootCompleted = (Invoke-Adb @('-s', $Serial, 'shell', 'getprop', 'sys.boot_completed')) -eq '1'
    $sdk = Invoke-Adb @('-s', $Serial, 'shell', 'getprop', 'ro.build.version.sdk')
    $manufacturer = Invoke-Adb @('-s', $Serial, 'shell', 'getprop', 'ro.product.manufacturer')
    $model = Invoke-Adb @('-s', $Serial, 'shell', 'getprop', 'ro.product.model')
    $packageDump = (& $script:Adb -s $Serial shell dumpsys package com.mathnotes.capture 2>&1) -join "`n"
    $appInstalled = $LASTEXITCODE -eq 0 -and $packageDump -match 'Package \[com\.mathnotes\.capture\]'
    $notificationGranted = $false
    if ($appInstalled) {
        $notificationGranted = $packageDump -match 'android\.permission\.POST_NOTIFICATIONS: granted=true'
    }

    $report = [ordered]@{
        schemaVersion = 1
        checkedAt = [DateTimeOffset]::Now.ToString('o')
        project = 'MathNotes'
        target = 'physical_android_device'
        serialRedacted = Redact-Serial $Serial
        manufacturer = $manufacturer
        model = $model
        androidSdk = [int]$sdk
        bootCompleted = $bootCompleted
        appInstalled = $appInstalled
        notificationPermission = if ($appInstalled) {
            if ($notificationGranted) { 'granted' } else { 'not_granted' }
        } else { 'app_not_installed' }
        hotspotUpload = 'MANUAL_UNVERIFIED'
        usbTetheringUpload = 'MANUAL_UNVERIFIED'
        physicalRebootRecovery = 'MANUAL_UNVERIFIED'
        secretsIncluded = $false
    }

    $json = $report | ConvertTo-Json -Depth 4
    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $absoluteOutput = if ([IO.Path]::IsPathRooted($OutputPath)) {
            $OutputPath
        } else {
            Join-Path (Resolve-Path -LiteralPath $ProjectRoot).Path $OutputPath
        }
        $parent = Split-Path -Parent $absoluteOutput
        if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
        [IO.File]::WriteAllText($absoluteOutput, $json, [Text.UTF8Encoding]::new($false))
    }
    $json
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
