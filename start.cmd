@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8769/'; if ($r.Content.Contains('TAKECUT')) { Start-Process 'http://127.0.0.1:8769/'; exit 0 } } catch {}; exit 1"
if not errorlevel 1 exit /b 0
where py >nul 2>nul
if errorlevel 1 goto usepython
py -3 server.py --open
goto finished
:usepython
python server.py --open
:finished
if errorlevel 1 pause
