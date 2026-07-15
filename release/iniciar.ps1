$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host '[ERRO] Node.js nao encontrado. Instale em https://nodejs.org'
  Write-Host ''
  Read-Host 'Pressione Enter para sair'
  exit 1
}

if (-not (Test-Path '.env')) {
  Write-Host ''
  Write-Host '[AVISO] Arquivo .env nao encontrado. Copiando .env.example ...'
  Copy-Item '.env.example' '.env'
  Write-Host 'Edite o .env e coloque sua KLIVA_LICENSE_KEY antes de continuar.'
  Write-Host ''
  Read-Host 'Pressione Enter para sair'
  exit 1
}

Write-Host ''
Write-Host 'Iniciando KLIVA...'
Write-Host 'Acesse http://localhost:4000 no navegador.'
Write-Host ''
node launcher.mjs
