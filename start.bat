@echo off
rem Starts the local server for the asset browser / Atlas and opens it in your browser (needed for Live; close this window to stop).
cd /d "%~dp0"
python toolbox\serve.py
pause
