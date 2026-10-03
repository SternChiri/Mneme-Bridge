# 移除开机自启
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'mneme-bridge-tray.lnk'
if (Test-Path $lnk) { Remove-Item $lnk; Write-Host '已移除开机自启' } else { Write-Host '未找到自启项' }
