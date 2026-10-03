# deploy —— bridge 常驻部署件

## 推荐路径（托盘常驻，两步）

1. **双击 bridge-tray.cmd** → 任务栏右下角出现蓝色 M 图标，bridge 已在后台运行
   - 左键/右键菜单：打开状态页 / 重启 bridge / 退出
   - bridge 意外退出时气泡提醒
2. （可选，正式版）**双击 install-startup.cmd** → 创建开机自启，登录后托盘自动出现
   - 移除自启：运行 uninstall-startup.ps1（右键 → 使用 PowerShell 运行）

## 各文件说明

| 文件 | 用途 |
|---|---|
| bridge-tray.cmd | **双击这个**：启动托盘常驻（内部调 bridge-tray.ps1，绕开执行策略） |
| bridge-tray.ps1 | 托盘本体（ps1 已带 UTF-8 BOM；直接右键"使用 PowerShell 运行"也可以） |
| install-startup.cmd | 双击：创建开机自启（可重复运行无副作用） |
| install-startup.ps1 | 自启创建脚本 |
| uninstall-startup.ps1 | 移除开机自启 |
| start-hidden.vbs | 备选：完全无窗口后台运行（无托盘图标，停止用 mneme-bridge/stop-bridge.cmd） |

## 注意

- 托盘里的 bridge 进程在任务管理器显示为 node.exe，认准命令行 server.js
- 已有 start-bridge.cmd 开的窗口实例先关掉，否则托盘脚本会提示"已在运行"
- ps1 修改后必须保持 UTF-8 with BOM 编码（PowerShell 5.1 无 BOM 按 GBK 解码会乱码报错）
- 二期正式打包可升级 NSSM Windows 服务（崩溃自动拉起、无需登录会话）
