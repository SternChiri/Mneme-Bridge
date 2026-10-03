# 把托盘 bridge 装进开机自启（当前用户，登录后托盘自动出现）
$deployDir = $PSScriptRoot
$trayPs = Join-Path $deployDir 'bridge-tray.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'mneme-bridge-tray.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$trayPs`""
$sc.WorkingDirectory = $deployDir
$sc.WindowStyle = 7
$sc.Description = 'mneme memory bridge (tray)'
$sc.Save()
Write-Host "已创建开机自启: $lnk"
Write-Host '下次登录起，托盘将自动出现 mneme-bridge 图标'
