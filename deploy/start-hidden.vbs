' mneme-bridge 无窗口启动（后台运行）
' 停止：运行 stop-bridge.cmd 或任务管理器结束 node.exe
' 本文件放在 deploy/ 下，bridge 位于同级 mneme-bridge/；路径全部由脚本自身位置推导，不写死。
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = fso.GetParentFolderName(scriptDir) & "\mneme-bridge"
sh.Run "node server.js", 0, False
