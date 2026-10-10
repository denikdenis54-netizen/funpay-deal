@echo off
chcp 65001 >nul
title FunPay Deal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1"
pause