@echo off
setlocal
cd /d "%~dp0"
rem If Takecut is already running, just open it.
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8769/'; if ($r.Content.Contains('TAKECUT')) { Start-Process 'http://127.0.0.1:8769/'; exit 0 } } catch {}; exit 1"
if not errorlevel 1 exit /b 0
where py >nul 2>nul
if errorlevel 1 goto usepython
py -3 -m takecut --open
goto finished
:usepython
python -m takecut --open
:finished
if errorlevel 1 pause
