#!/usr/bin/env node
/**
 * Gera pacote de distribuicao KLIVA (sem codigo-fonte).
 *
 * Uso (na raiz do projeto):
 *   npm run release
 *   npm run release -- --version=1.0.0
 *
 * Requer no .env do desenvolvedor:
 *   LICENSE_SIGNING_SECRET=uma-chave-secreta-longa
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(ROOT, '.env') });

const versionArg = process.argv.find((a) => a.startsWith('--version='));
const VERSION = versionArg?.split('=')[1] || process.env.KLIVA_RELEASE_VERSION || '1.0.0';
const LICENSE_SECRET = (process.env.LICENSE_SIGNING_SECRET || '').trim();
const OUT_BASE = path.join(ROOT, 'dist-release');
const BUILD_DIR = path.join(OUT_BASE, '.build');
const PKG_DIR = path.join(OUT_BASE, `kliva-v${VERSION}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`Comando falhou: ${cmd} ${args.join(' ')}`);
  }
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`Pasta nao encontrada: ${src}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else copyFile(from, to);
  }
}

function writeRunScript(name, bundleFile) {
  const content = `import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
process.env.KLIVA_ROOT = process.env.KLIVA_ROOT || path.resolve(root, '..');
process.env.KLIVA_RELEASE = process.env.KLIVA_RELEASE || '1';

await import('./${bundleFile}');
`;
  fs.writeFileSync(path.join(PKG_DIR, 'app', name), content, 'utf8');
}

async function bundleBackend() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  await esbuild.build({
    entryPoints: {
      server: path.join(ROOT, 'server', 'index.js'),
      'bot-activate': path.join(ROOT, 'bot', 'activate', 'cli.js'),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    outdir: BUILD_DIR,
    outExtension: { '.js': '.mjs' },
    packages: 'external',
    logLevel: 'info',
    minify: true,
    legalComments: 'none',
    define: {
      'process.env.__KLIVA_LICENSE_SECRET__': JSON.stringify(LICENSE_SECRET),
    },
  });
}

function installAppBundles() {
  const appDir = path.join(PKG_DIR, 'app');
  fs.mkdirSync(appDir, { recursive: true });

  const entries = [
    { src: path.join(BUILD_DIR, 'server.mjs'), bundle: 'server.mjs', runner: 'run-server.mjs' },
    {
      src: path.join(BUILD_DIR, 'bot-activate.mjs'),
      bundle: 'bot-activate.mjs',
      runner: 'run-activate.mjs',
    },
  ];

  for (const { src, bundle, runner } of entries) {
    if (!fs.existsSync(src)) throw new Error(`Bundle nao encontrado: ${src}`);
    copyFile(src, path.join(appDir, bundle));
    writeRunScript(runner, bundle);
  }

  fs.writeFileSync(
    path.join(appDir, 'manifest.json'),
    JSON.stringify(
      {
        version: VERSION,
        builtAt: new Date().toISOString(),
        nodeMin: '18.0.0',
        bundleFormat: 'esbuild-esm-minify',
        licenseMode: LICENSE_SECRET ? 'offline+hmac' : 'online-only',
      },
      null,
      2,
    ),
    'utf8',
  );
}

function createPackageJson() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pkg = {
    name: 'kliva',
    version: VERSION,
    private: true,
    type: 'module',
    description: 'KLIVA — automacao Grok com interface de gerenciamento.',
    scripts: {
      start: 'node launcher.mjs',
    },
    engines: rootPkg.engines || { node: '>=18' },
    dependencies: {
      ...rootPkg.dependencies,
    },
  };
  fs.writeFileSync(path.join(PKG_DIR, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
}

function createDataTemplates() {
  const dataDir = path.join(PKG_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.gitkeep'), '', 'utf8');

  for (const name of ['accounts.example.txt', 'payer-results.example.txt']) {
    copyFile(path.join(ROOT, name), path.join(PKG_DIR, name));
  }
}

function patchEnvExample() {
  const src = path.join(ROOT, '.env.example');
  const dest = path.join(PKG_DIR, '.env.example');
  let text = fs.readFileSync(src, 'utf8');
  if (!text.includes('KLIVA_LICENSE_KEY')) {
    text =
      `# ===== Licenca KLIVA =====\nKLIVA_LICENSE_KEY=\n# Opcional: validacao online (se voce fornecer API)\n# KLIVA_LICENSE_URL=https://sua-api.com/validate\n\n` +
      text;
  }
  fs.writeFileSync(dest, text, 'utf8');
}

function createZip() {
  const zipName = `kliva-v${VERSION}.zip`;
  const zipPath = path.join(OUT_BASE, zipName);
  rmrf(zipPath);

  if (process.platform === 'win32') {
    run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${PKG_DIR}\\*' -DestinationPath '${zipPath}' -Force`,
    ]);
  } else {
    run('zip', ['-r', zipPath, '.'], { cwd: PKG_DIR });
  }
  return zipPath;
}

async function main() {
  console.log(`\n[release] KLIVA v${VERSION}\n`);

  if (!LICENSE_SECRET) {
    console.warn(
      '[release] AVISO: LICENSE_SIGNING_SECRET nao definido — licencas offline nao funcionarao.',
    );
    console.warn('[release] Defina no .env ou use KLIVA_LICENSE_URL no pacote do cliente.\n');
  }

  rmrf(OUT_BASE);
  fs.mkdirSync(PKG_DIR, { recursive: true });

  console.log('[release] 1/7 — build da UI...');
  run('npm', ['run', 'build:kliva']);

  console.log('[release] 2/7 — bundle do backend (esbuild)...');
  await bundleBackend();

  console.log('[release] 3/7 — empacotar backend (bundles minificados)...');
  installAppBundles();

  console.log('[release] 4/7 — copiar UI e arquivos do cliente...');
  copyDir(path.join(ROOT, 'ui', 'dist'), path.join(PKG_DIR, 'ui', 'dist'));
  copyFile(path.join(ROOT, 'release', 'launcher.mjs'), path.join(PKG_DIR, 'launcher.mjs'));
  copyFile(path.join(ROOT, 'release', 'iniciar.bat'), path.join(PKG_DIR, 'iniciar.bat'));
  copyFile(path.join(ROOT, 'release', 'iniciar.ps1'), path.join(PKG_DIR, 'iniciar.ps1'));
  copyFile(path.join(ROOT, 'release', 'codigo-ativacao.bat'), path.join(PKG_DIR, 'codigo-ativacao.bat'));
  copyFile(path.join(ROOT, 'release', 'codigo-ativacao.mjs'), path.join(PKG_DIR, 'codigo-ativacao.mjs'));
  copyFile(path.join(ROOT, 'release', 'LEIA-ME.txt'), path.join(PKG_DIR, 'LEIA-ME.txt'));
  createDataTemplates();
  patchEnvExample();
  createPackageJson();

  console.log('[release] 5/7 — npm install (producao)...');
  run('npm', ['install', '--omit=dev'], { cwd: PKG_DIR });

  console.log('[release] 6/7 — zip...');
  const zipPath = createZip();

  console.log('[release] 7/7 — limpeza...');
  rmrf(BUILD_DIR);

  console.log('\n[release] Pacote pronto!');
  console.log(`  Pasta: ${PKG_DIR}`);
  console.log(`  ZIP:   ${zipPath}`);
  console.log('\n[release] Proximo passo: gere uma licenca por cliente:');
  console.log('  npm run license:generate -- --email=cliente@email.com --days=365\n');
}

main().catch((err) => {
  console.error('[release] ERRO:', err.message);
  process.exit(1);
});
