Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
' node.exe：优先环境变量 NODE_EXE，其次常见安装目录，最后退回 PATH
nodeExe = ""
candidates = Array(WshShell.ExpandEnvironmentStrings("%NODE_EXE%"), _
  WshShell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe", _
  WshShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe", _
  WshShell.ExpandEnvironmentStrings("%LocalAppData%") & "\Programs\nodejs\node.exe")
For Each c In candidates
  If c <> "" And InStr(c, "%") = 0 Then
    If fso.FileExists(c) Then
      nodeExe = c
      Exit For
    End If
  End If
Next
If nodeExe = "" Then
  WshShell.Run "cmd /c node server.js >> logs\bridge-stdout.log 2>&1", 0, False
Else
  WshShell.Run "cmd /c """ & nodeExe & """ server.js >> logs\bridge-stdout.log 2>&1", 0, False
End If
