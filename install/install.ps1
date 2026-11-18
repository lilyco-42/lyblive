# lyblive 一键安装（Windows）
# 用法（PowerShell）：
#   irm https://raw.githubusercontent.com/lilyco-42/lyblive/main/install/install.ps1 | iex
#   $env:LYBLIVE_VERSION = 'v0.1.3'; irm ... | iex    # 指定版本
$ErrorActionPreference = 'Stop'

$Repo    = 'lilyco-42/lyblive'
$Version = $env:LYBLIVE_VERSION
$Asset   = 'lyblive-windows-x86_64.exe'
$Dir     = Join-Path $env:LOCALAPPDATA 'lyblive'
$Exe     = Join-Path $Dir 'lyblive.exe'

if ($Version) {
  $Base = "https://github.com/$Repo/releases/download/$Version"
} else {
  $Base = "https://github.com/$Repo/releases/latest/download"
}

Write-Host "==> 下载 $Asset"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$TmpExe = Join-Path $Dir 'lyblive.download.exe'
Invoke-WebRequest -Uri "$Base/$Asset" -OutFile $TmpExe -UseBasicParsing

Write-Host "==> 校验 SHA256"
$SumsText = (Invoke-WebRequest -Uri "$Base/SHA256SUMS" -UseBasicParsing).Content
$Line = ($SumsText -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" } | Select-Object -First 1
if (-not $Line) { throw "SHA256SUMS 中找不到 $Asset" }
$Expected = ($Line -split '\s+')[0].ToLower()
$Actual   = (Get-FileHash -Algorithm SHA256 -Path $TmpExe).Hash.ToLower()
if ($Actual -ne $Expected) {
  Remove-Item $TmpExe -Force
  throw "校验失败：期望 $Expected，实际 $Actual"
}

Move-Item -Force $TmpExe $Exe

# 把安装目录加入用户级 PATH（幂等）
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($UserPath -split ';' | Where-Object { $_ -eq $Dir })) {
  $NewPath = if ([string]::IsNullOrEmpty($UserPath)) { $Dir } else { "$UserPath;$Dir" }
  [Environment]::SetEnvironmentVariable('Path', $NewPath, 'User')
  Write-Host "==> 已把 $Dir 加入用户 PATH（新开的终端生效）"
}

Write-Host "==> 已安装到 $Exe"
& $Exe --version

Write-Host ""
Write-Host "下一步："
Write-Host "  1) 启动 Web 控制台：lyblive --web"
Write-Host "  2) 浏览器打开 http://127.0.0.1:8769/ 扫码登录 B 站"
Write-Host "  3) 想在 OBS 里用：先完全退出 OBS，再执行 lyblive --obs-install"