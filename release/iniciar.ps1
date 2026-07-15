$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host '[ERRO] Node.js nao encontrado. Instale em https://nodejs.org'
  Write-Host '       Recomendado: versao 20 LTS (minimo 18)'
  Write-Host ''
  Read-Host 'Pressione Enter para sair'
  exit 1
}

$nodeMajor = [int]($env:NODE_OPTIONS = $null; node -p "parseInt(process.versions.node.split('.')[0],10)")
if ($nodeMajor -lt 18) {
  $ver = node -p "process.version"
  Write-Host ''
  Write-Host "[ERRO] Node.js $ver detectado."
  Write-Host '[ERRO] KLIVA exige Node.js 18 ou superior (recomendado: 20 LTS).'
  Write-Host '[ERRO] Baixe em https://nodejs.org/'
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
