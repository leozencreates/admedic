@echo off
rem Admedic - yerel gelistirme ortamini ayaga kaldirir (bkz. scripts\dev-up.ps1)
powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0dev-up.ps1" %*
