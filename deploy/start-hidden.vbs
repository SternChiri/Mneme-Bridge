' mneme-bridge 无窗口启动（后台运行）
' 停止：运行 stop-bridge.cmd 或任务管理器结束 node.exe
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "F:\DeepSeek\work\mneme-memory-project\mneme-bridge\"
sh.Run "node server.js", 0, False
