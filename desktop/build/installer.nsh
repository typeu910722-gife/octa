; OCTA installer: before the old version is removed, end every program that keeps the OCTA folder busy:
; OCTA.exe (and copies of it running as node), Electron helpers next to it, and programs OCTA started from its data
; folder (the bots' Chrome windows, cloudflared, Python for browser-use). Otherwise Windows keeps the folder locked and
; the installer stops with "無法卸載舊的應用程式檔案". The script is written to a file line by line (NSIS strings are
; limited to 1024 characters, so a long command line would be cut off).
!macro octaEndRunning
  nsExec::Exec 'taskkill /F /T /IM "OCTA.exe"'
  Pop $0
  FileOpen $1 "$TEMP\octa-end.ps1" w
  FileWrite $1 `Start-Sleep -Milliseconds 300$\r$\n`
  FileWrite $1 `$$roots = @("$$env:APPDATA\OCTA\", "$$env:LOCALAPPDATA\Programs\octa-desktop\")$\r$\n`
  FileWrite $1 `foreach ($$p in Get-CimInstance Win32_Process) {$\r$\n`
  FileWrite $1 `  if ($$p.ProcessId -eq $$PID) { continue }$\r$\n`
  FileWrite $1 `  $$exe = [string]$$p.ExecutablePath; $$cmd = [string]$$p.CommandLine$\r$\n`
  FileWrite $1 `  if (-not $$exe) { continue }$\r$\n`
  FileWrite $1 `  $$leaf = Split-Path -Leaf $$exe$\r$\n`
  FileWrite $1 `  if ($$leaf -like 'Uninstall*' -or $$leaf -like '*Setup*' -or $$cmd -like '*reopen-octa*' -or $$cmd -like '*octa-end.ps1*') { continue }$\r$\n`
  FileWrite $1 `  $$hit = Test-Path -LiteralPath (Join-Path (Split-Path -LiteralPath $$exe) 'OCTA.exe')$\r$\n`
  FileWrite $1 `  if (-not $$hit) { foreach ($$r in $$roots) { if ($$exe.StartsWith($$r, 'OrdinalIgnoreCase') -or $$cmd.IndexOf($$r, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $$hit = $$true; break } } }$\r$\n`
  FileWrite $1 `  if ($$hit) { Stop-Process -Id $$p.ProcessId -Force -ErrorAction SilentlyContinue }$\r$\n`
  FileWrite $1 `}$\r$\n`
  FileClose $1
  nsExec::Exec 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$TEMP\octa-end.ps1"'
  Pop $0
  Delete "$TEMP\octa-end.ps1"
  Sleep 2000
!macroend
!macro customInit
  !insertmacro octaEndRunning
!macroend
!macro customCheckAppRunning
  !insertmacro octaEndRunning
!macroend
