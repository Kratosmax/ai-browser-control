# Generate AI Browser Control extension icons:
# dark rounded background + browser window + orange cursor.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File make-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$master = [System.Drawing.Bitmap]::new(256, 256)
$g = [System.Drawing.Graphics]::FromImage($master)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

function Rounded([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}
function Solid([int]$r, [int]$gg, [int]$b) {
  return [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, $r, $gg, $b))
}

# dark rounded background
$g.FillPath((Solid 30 41 59), (Rounded 8 8 240 240 56))
# white browser window with blue title bar
$g.FillPath([System.Drawing.Brushes]::White, (Rounded 40 66 176 148 18))
$barBrush = (Solid 37 99 235)
$g.FillPath($barBrush, (Rounded 40 66 176 40 18))
$g.FillRectangle($barBrush, 40, 88, 176, 18)
# three window dots
foreach ($cx in 58, 82, 106) {
  $g.FillEllipse([System.Drawing.Brushes]::White, $cx - 7, 76, 14, 14)
}
# orange cursor arrow with white outline
$points = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(150, 120),
  [System.Drawing.PointF]::new(150, 214),
  [System.Drawing.PointF]::new(175, 191),
  [System.Drawing.PointF]::new(190, 222),
  [System.Drawing.PointF]::new(205, 214),
  [System.Drawing.PointF]::new(190, 184),
  [System.Drawing.PointF]::new(219, 180)
)
$white = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 14)
$white.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$g.DrawPolygon($white, $points)
$g.FillPolygon((Solid 249 115 22), $points)

$g.Dispose()

foreach ($size in 128, 48, 16) {
  $icon = [System.Drawing.Bitmap]::new($size, $size)
  $ig = [System.Drawing.Graphics]::FromImage($icon)
  $ig.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $ig.DrawImage($master, 0, 0, $size, $size)
  $ig.Dispose()
  $icon.Save((Join-Path $outDir "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $icon.Dispose()
}
$master.Dispose()
Write-Output "icons written to $outDir"
