@echo off
rem Admedic - PostgreSQL'i kurar/baslatir ve proje veritabanini hazirlar (bkz. scripts\setup-postgres.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-postgres.ps1"
