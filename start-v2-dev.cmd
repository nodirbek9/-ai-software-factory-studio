@echo off
rem Starts the V2 development studio (API http://127.0.0.1:4327, dashboard http://127.0.0.1:5327).
rem It uses its own data folder (asf-v2\data, from .env), so the V1 studio on port 4317 is not affected.
rem Close this window (or press Ctrl+C) to stop it.
title Software Factory Agent Studio V2 (dev)
cd /d "%~dp0"
call npm.cmd run dev
pause
