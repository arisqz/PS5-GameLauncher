@echo off
rem Builds syshelper.exe with the C# compiler that ships with Windows (.NET Framework 4.x).
setlocal
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
set WM=%WINDIR%\System32\WinMetadata
cd /d "%~dp0"
"%FW%\csc.exe" /nologo /codepage:65001 /optimize+ /target:exe /platform:x64 /out:syshelper.exe ^
  /r:"%WM%\Windows.Foundation.winmd" /r:"%WM%\Windows.Media.winmd" /r:"%WM%\Windows.Storage.winmd" /r:"%WM%\Windows.Devices.winmd" ^
  /r:"%FW%\System.Runtime.dll" /r:"%FW%\System.Runtime.InteropServices.WindowsRuntime.dll" ^
  /r:System.Web.Extensions.dll /r:System.Management.dll ^
  syshelper.cs
