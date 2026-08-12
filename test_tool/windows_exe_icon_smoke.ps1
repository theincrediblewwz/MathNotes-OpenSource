param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath
)

$ErrorActionPreference = "Stop"
$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path
Add-Type -AssemblyName System.Drawing

$extracted = [System.Drawing.Icon]::ExtractAssociatedIcon($resolvedExe)
if ($null -eq $extracted) {
    throw "WINDOWS_EXE_ICON_MISSING: $resolvedExe"
}

function New-NormalizedBitmap([System.Drawing.Icon]$Icon) {
    $bitmap = [System.Drawing.Bitmap]::new(32, 32, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.DrawIcon($Icon, [System.Drawing.Rectangle]::new(0, 0, 32, 32))
    } finally {
        $graphics.Dispose()
    }
    return $bitmap
}

$actualBitmap = New-NormalizedBitmap $extracted
try {
    $visiblePixels = 0
    $pixels = [System.Collections.Generic.List[byte]]::new()
    for ($y = 0; $y -lt 32; $y++) {
        for ($x = 0; $x -lt 32; $x++) {
            $actualPixel = $actualBitmap.GetPixel($x, $y)
            if ($actualPixel.A -gt 0) { $visiblePixels++ }
            $pixels.Add($actualPixel.A)
            $pixels.Add($actualPixel.R)
            $pixels.Add($actualPixel.G)
            $pixels.Add($actualPixel.B)
        }
    }
    if ($visiblePixels -lt 128) {
        throw "WINDOWS_EXE_ICON_EMPTY: visible_pixels=$visiblePixels"
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $signature = ([BitConverter]::ToString($sha.ComputeHash($pixels.ToArray()))).Replace("-", "")
    } finally {
        $sha.Dispose()
    }
    $approvedSignature = "0E3057D61FC949DA321CA135BD0BA36F58D185CE4C0D04DF5276F0E266CE3D82"
    if ($signature -ne $approvedSignature) {
        throw "WINDOWS_EXE_ICON_MISMATCH: signature=$signature"
    }
    Write-Output "WINDOWS_EXE_ICON_OK visible_pixels=$visiblePixels signature=$signature"
} finally {
    $actualBitmap.Dispose()
    $extracted.Dispose()
}
