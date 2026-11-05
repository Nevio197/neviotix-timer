Option Explicit

' Double-clickable and callable by OBS. The Node process is always hidden.
Dim shell, files, root, node, action, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"

If Not files.FileExists(node) Then
  node = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe"
End If
If Not files.FileExists(node) Then WScript.Quit 2
If Not files.FileExists(root & "\launch.cjs") Then WScript.Quit 3

action = "start"
If WScript.Arguments.Count > 0 Then action = LCase(WScript.Arguments(0))
Select Case action
  Case "start", "toggle", "reset", "plus60", "minus60"
  Case Else
    WScript.Quit 4
End Select

command = Quote(node) & " " & Quote(root & "\launch.cjs") & " " & action
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
