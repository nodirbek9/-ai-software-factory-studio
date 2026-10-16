@echo off
rem Starts AI Software Factory Studio (builds the dashboard, then serves it on http://127.0.0.1:4317).
rem Double-click this file, or run it from a terminal. Close this window (or press Ctrl+C) to stop the studio.
title AI Software Factory Studio
cd /d "%~dp0"
call npm.cmd start
pause
