@echo off
title KLIVA
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  echo        Recomendado: versao 20 LTS ^(minimo 18^)
  echo.
  pause
  exit /b 1
)

node -e "const m=parseInt(process.versions.node.split('.')[0],10);if(m<18){console.error('');console.error('[ERRO] Node.js '+process.version+' detectado.');console.error('[ERRO] KLIVA exige Node.js 18 ou superior (recomendado: 20 LTS).');console.error('[ERRO] Baixe em https://nodejs.org/');console.error('[ERRO] Depois de instalar, feche e abra o terminal e rode iniciar.bat de novo.');console.error('');process.exit(1)}"
if errorlevel 1 (
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
