; OCTA installer: before the old version is removed, end every program still running from an OCTA folder
; (OCTA.exe, copies of it running as node for the browser tools, Electron helpers). Otherwise Windows keeps the
; files locked and the installer stops with "無法卸載舊的應用程式檔案".
; The PowerShell script (encoded so no quoting goes wrong):
; Start-Sleep -Milliseconds 300; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ProcessId -ne $PID -and (Test-Path -LiteralPath (Join-Path (Split-Path -LiteralPath $_.ExecutablePath) 'OCTA.exe')) -and ((Split-Path -Leaf $_.ExecutablePath) -notlike 'Uninstall*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
!macro octaEndRunning
  nsExec::Exec 'taskkill /F /T /IM "OCTA.exe"'
  Pop $0
  nsExec::Exec 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand UwB0AGEAcgB0AC0AUwBsAGUAZQBwACAALQBNAGkAbABsAGkAcwBlAGMAbwBuAGQAcwAgADMAMAAwADsAIABHAGUAdAAtAEMAaQBtAEkAbgBzAHQAYQBuAGMAZQAgAFcAaQBuADMAMgBfAFAAcgBvAGMAZQBzAHMAIAB8ACAAVwBoAGUAcgBlAC0ATwBiAGoAZQBjAHQAIAB7ACAAJABfAC4ARQB4AGUAYwB1AHQAYQBiAGwAZQBQAGEAdABoACAALQBhAG4AZAAgACQAXwAuAFAAcgBvAGMAZQBzAHMASQBkACAALQBuAGUAIAAkAFAASQBEACAALQBhAG4AZAAgACgAVABlAHMAdAAtAFAAYQB0AGgAIAAtAEwAaQB0AGUAcgBhAGwAUABhAHQAaAAgACgASgBvAGkAbgAtAFAAYQB0AGgAIAAoAFMAcABsAGkAdAAtAFAAYQB0AGgAIAAtAEwAaQB0AGUAcgBhAGwAUABhAHQAaAAgACQAXwAuAEUAeABlAGMAdQB0AGEAYgBsAGUAUABhAHQAaAApACAAJwBPAEMAVABBAC4AZQB4AGUAJwApACkAIAAtAGEAbgBkACAAKAAoAFMAcABsAGkAdAAtAFAAYQB0AGgAIAAtAEwAZQBhAGYAIAAkAF8ALgBFAHgAZQBjAHUAdABhAGIAbABlAFAAYQB0AGgAKQAgAC0AbgBvAHQAbABpAGsAZQAgACcAVQBuAGkAbgBzAHQAYQBsAGwAKgAnACkAIAB9ACAAfAAgAEYAbwByAEUAYQBjAGgALQBPAGIAagBlAGMAdAAgAHsAIABTAHQAbwBwAC0AUAByAG8AYwBlAHMAcwAgAC0ASQBkACAAJABfAC4AUAByAG8AYwBlAHMAcwBJAGQAIAAtAEYAbwByAGMAZQAgAC0ARQByAHIAbwByAEEAYwB0AGkAbwBuACAAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQAgAH0A'
  Pop $0
  Sleep 1500
!macroend
!macro customInit
  !insertmacro octaEndRunning
!macroend
!macro customCheckAppRunning
  !insertmacro octaEndRunning
!macroend
