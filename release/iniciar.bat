@echo off
title KLIVA
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo.
  echo [AVISO] Arquivo .env nao encontrado. Copiando .env.example ...
  copy /Y ".env.example" ".env" >nul
  echo Edite o .env e coloque sua KLIVA_LICENSE_KEY antes de continuar.
  echo.
  pause
  exit /b 1
)

echo.
echo Iniciando KLIVA...
echo Acesse http://localhost:4000 no navegador.
echo.
node launcher.mjs
pause
