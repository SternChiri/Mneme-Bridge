Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
' node.exe: prefer Program Files default location, fallback to PATH
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  WshShell.Run "cmd /c ""C:\Program Files\nodejs\node.exe"" server.js >> logs\bridge-stdout.log 2>&1", 0, False
Else
  WshShell.Run "cmd /c node server.js >> logs\bridge-stdout.log 2>&1", 0, False
End If
