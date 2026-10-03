# mneme-bridge 托盘常驻（隐藏窗口 + 托盘图标 + 右键菜单）
# 执行方式：双击同目录 bridge-tray.cmd（推荐）；开机自启：双击 install-startup.cmd 一次
$ErrorActionPreference = 'Stop'
$deployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeDir = Join-Path (Split-Path -Parent $deployDir) 'mneme-bridge'
$iconPath = Join-Path (Split-Path -Parent $deployDir) 'assets\mneme-bridge.ico'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 防重复启动：8760 已监听就不再起
$listening = Get-NetTCPConnection -LocalPort 8760 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  [System.Windows.Forms.MessageBox]::Show('mneme-bridge 已在运行 (端口 8760)', 'mneme-bridge') | Out-Null
  exit 0
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = 'server.js'
$psi.WorkingDirectory = $bridgeDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$script:proc = [System.Diagnostics.Process]::Start($psi)
try { Set-Content -Path (Join-Path $bridgeDir 'logs\tray-diag.txt') -Value ("tray started node pid=" + $script:proc.Id + " at " + (Get-Date -Format 'HH:mm:ss')) } catch { Set-Content -Path (Join-Path $bridgeDir 'logs\tray-diag.txt') -Value ("diag write fail: " + $_) }

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Text = 'mneme-bridge :8760 (运行中)'
$icon.Visible = $true
# 使用项目 Logo（多尺寸 .ico，托盘自动选 16px 档；缺失时回退程序生成蓝底 M）
if (Test-Path $iconPath) {
  $icon.Icon = New-Object System.Drawing.Icon($iconPath, 16, 16)
} else {
  $bmp = New-Object System.Drawing.Bitmap 16,16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(30,64,175))
  $g.DrawString('M', (New-Object System.Drawing.Font('Arial',10,[System.Drawing.FontStyle]::Bold)), [System.Drawing.Brushes]::White, 1, 0)
  $g.Dispose()
  $icon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add('打开状态页', $null, { Start-Process 'http://127.0.0.1:8760/health' }) | Out-Null
$menu.Items.Add('重启 bridge', $null, {
  if ($script:proc -and !$script:proc.HasExited) { $script:proc.Kill(); $script:proc.WaitForExit(3000) | Out-Null }
  $script:proc = [System.Diagnostics.Process]::Start($psi)
  $icon.ShowBalloonTip(2000, 'mneme-bridge', '已重启', 'Info')
}) | Out-Null
$menu.Items.Add('退出（停止 bridge）', $null, {
  if ($script:proc -and !$script:proc.HasExited) { $script:proc.Kill() }
  $icon.Visible = $false
  [System.Windows.Forms.Application]::Exit()
}) | Out-Null
$icon.ContextMenuStrip = $menu

# bridge 进程意外退出时气泡提醒
$script:restarting = $false
Register-ObjectEvent $script:proc Exited -Action {
  if (-not $script:restarting) {
    $icon.ShowBalloonTip(3000, 'mneme-bridge', 'bridge 进程已退出（托盘右键可重启）', 'Error')
  }
} | Out-Null

[System.Windows.Forms.Application]::Run()
