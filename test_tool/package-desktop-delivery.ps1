param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$WindowsZip,

    [Parameter(Mandatory = $true)]
    [string]$MacZip,

    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectPath = [System.IO.Path]::GetFullPath($ProjectRoot)
$windowsSource = [System.IO.Path]::GetFullPath($WindowsZip)
$macSource = [System.IO.Path]::GetFullPath($MacZip)
$commit = (git -C $projectPath rev-parse --short=8 HEAD).Trim()
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $projectPath "output\delivery\MathNotes桌面版-$commit"
}
$deliveryPath = [System.IO.Path]::GetFullPath($OutputRoot)
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $projectPath 'output\delivery'))
if (-not $deliveryPath.StartsWith($allowedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "DELIVERY_PATH_OUTSIDE_ALLOWED_ROOT: $deliveryPath"
}
if (-not (Test-Path -LiteralPath $windowsSource -PathType Leaf)) { throw "WINDOWS_ZIP_MISSING: $windowsSource" }
if (-not (Test-Path -LiteralPath $macSource -PathType Leaf)) { throw "MACOS_ZIP_MISSING: $macSource" }

if (Test-Path -LiteralPath $deliveryPath) {
    Remove-Item -LiteralPath $deliveryPath -Recurse -Force
}
New-Item -ItemType Directory -Path $deliveryPath | Out-Null

$windowsTarget = Join-Path $deliveryPath '02-Windows-PC版-便携包.zip'
$macTarget = Join-Path $deliveryPath '03-macOS-Apple芯片版.zip'
$windowsExtracted = Join-Path $deliveryPath '01-Windows-PC版-解压即用'
Copy-Item -LiteralPath $windowsSource -Destination $windowsTarget
Copy-Item -LiteralPath $macSource -Destination $macTarget
Expand-Archive -LiteralPath $windowsTarget -DestinationPath $windowsExtracted

$windowsExe = Get-ChildItem -LiteralPath $windowsExtracted -Recurse -File -Filter 'MathNotes.exe' | Select-Object -First 1
if (-not $windowsExe) { throw 'WINDOWS_EXECUTABLE_MISSING' }

function Get-ZipMetrics([string]$Path) {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })
        $unpacked = ($entries | Measure-Object -Property Length -Sum).Sum
        [pscustomobject]@{
            compressedBytes = (Get-Item -LiteralPath $Path).Length
            unpackedBytes = [long]$unpacked
            entryCount = $entries.Count
            entryNames = @($entries | ForEach-Object FullName)
        }
    } finally {
        $archive.Dispose()
    }
}

$windowsMetrics = Get-ZipMetrics $windowsTarget
$macMetrics = Get-ZipMetrics $macTarget
if (-not ($macMetrics.entryNames | Where-Object { $_ -match '^MathNotes\.app/Contents/MacOS/MathNotes$' })) {
    throw 'MACOS_APP_EXECUTABLE_MISSING'
}

$windowsAllLocalesCounterfactual = $windowsMetrics.unpackedBytes + 45249983L
$macHistoricalUnpacked = 122986207L
$report = [ordered]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToString('o')
    gitCommit = (git -C $projectPath rev-parse HEAD).Trim()
    primaryMetric = 'unpackedBytes'
    windows = [ordered]@{
        artifact = (Split-Path -Leaf $windowsTarget)
        executable = $windowsExe.FullName.Substring($deliveryPath.Length + 1)
        compressedBytes = $windowsMetrics.compressedBytes
        unpackedBytes = $windowsMetrics.unpackedBytes
        baselineKind = 'same Electron runtime with all 55 Chromium locales'
        baselineUnpackedBytes = $windowsAllLocalesCounterfactual
        removedUnpackedBytes = 45249983L
        retainedLocales = @('en-US', 'zh-CN')
        runtimeBoundary = 'Electron/Chromium retained; license, PDF runtime and GPU fallback retained'
        signing = 'unsigned private-test portable package'
    }
    macos = [ordered]@{
        artifact = (Split-Path -Leaf $macTarget)
        compressedBytes = $macMetrics.compressedBytes
        unpackedBytes = $macMetrics.unpackedBytes
        baselineKind = 'previous unstripped Apple-silicon artifact'
        baselineUnpackedBytes = $macHistoricalUnpacked
        removedUnpackedBytes = [long]($macHistoricalUnpacked - $macMetrics.unpackedBytes)
        runtimeBoundary = 'bundled Node retained; copied Mach-O binaries stripped before ad-hoc signing'
        signing = 'ad-hoc self-use; not notarized'
    }
}

$reportPath = Join-Path $deliveryPath '体积报告.json'
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding utf8

$windowsMiB = [math]::Round($windowsMetrics.unpackedBytes / 1MB, 2)
$macMiB = [math]::Round($macMetrics.unpackedBytes / 1MB, 2)
$windowsSavedMiB = [math]::Round(45249983 / 1MB, 2)
$macSavedMiB = [math]::Round(($macHistoricalUnpacked - $macMetrics.unpackedBytes) / 1MB, 2)
$instructions = @"
MathNotes 桌面测试版交付（commit $commit）

Windows：
1. 直接打开“01-Windows-PC版-解压即用”。
2. 进入其中的 MathNotes-win32-x64 文件夹，双击 MathNotes.exe。
3. 这是便携测试版，不需要安装；整个文件夹必须一起保留，不能只拿走 exe。

macOS（Apple 芯片）：
1. 把“03-macOS-Apple芯片版.zip”传到 Mac 后再解压。
2. 将 MathNotes.app 拖到“应用程序”。
3. 当前是 ad-hoc 自用签名、未公证测试版，不是已获得系统公开信任的正式发行版。

解压体积（主指标）：
- Windows：$windowsMiB MiB；相对保留全部 Chromium 语言包的同版本对照减少 $windowsSavedMiB MiB。
- macOS：$macMiB MiB；相对上一份未裁剪包减少 $macSavedMiB MiB。

完整字节数、基线定义和签名边界见“体积报告.json”；文件校验见“SHA256SUMS.txt”。
"@
$instructionsPath = Join-Path $deliveryPath '安装与体积说明.txt'
$instructions | Set-Content -LiteralPath $instructionsPath -Encoding utf8

$checksumTargets = @($windowsTarget, $macTarget, $reportPath, $instructionsPath)
$checksumLines = foreach ($file in $checksumTargets) {
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $(Split-Path -Leaf $file)"
}
$checksumsPath = Join-Path $deliveryPath 'SHA256SUMS.txt'
$checksumLines | Set-Content -LiteralPath $checksumsPath -Encoding utf8

$transferPath = Join-Path $deliveryPath "MathNotes-PC和Mac交付总包-$commit.zip"
Compress-Archive -LiteralPath $windowsTarget, $macTarget, $instructionsPath, $reportPath, $checksumsPath -DestinationPath $transferPath -CompressionLevel Optimal
$transferHash = (Get-FileHash -LiteralPath $transferPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$transferHash  $(Split-Path -Leaf $transferPath)" | Add-Content -LiteralPath $checksumsPath -Encoding utf8

Write-Output "DESKTOP_DELIVERY_OK"
Write-Output "DESKTOP_DELIVERY_ROOT=$deliveryPath"
Write-Output "WINDOWS_EXECUTABLE=$($windowsExe.FullName)"
Write-Output "WINDOWS_UNPACKED_BYTES=$($windowsMetrics.unpackedBytes)"
Write-Output "MACOS_UNPACKED_BYTES=$($macMetrics.unpackedBytes)"
Write-Output "TRANSFER_ZIP=$transferPath"
Write-Output "TRANSFER_SHA256=$transferHash"
