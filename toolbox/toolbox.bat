@echo off
chcp 65001 >nul
title Arcanum Art Extractor - Toolbox
set PYTHONIOENCODING=utf-8
cd /d "%~dp0.."

where python >nul 2>nul
if %errorlevel%==0 (
    python "%~dp0toolbox_menu.py"
    goto :eof
)
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 "%~dp0toolbox_menu.py"
    goto :eof
)
echo Python was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
pause
