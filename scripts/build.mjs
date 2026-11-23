import { watch } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = resolve(root, 'output');
const distDir = resolve(outputDir, 'dist');
const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => !['--clean', '--watch', '--package'].includes(arg))) {
  console.error('Usage: node scripts/build.mjs [--clean|--watch|--package]');
  process.exit(1);
}

if (args.includes('--clean')) {
  // Keep ZIP releases and other deliverables in output/.
  await rm(distDir, { recursive: true, force: true });
  console.log('Cleaned output/dist/');
  process.exit(0);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.signal || result.status}).`);
  }
}

function buildExtension() {
  for (const target of ['content', 'background', 'offscreen', 'popup']) {
    console.log(`\nBuilding ${target}...`);
    run(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build'], {
      env: { ...process.env, BUILD_TARGET: target },
    });
  }
  console.log(`\nBuild complete: ${distDir}`);
}

try {
  await mkdir(outputDir, { recursive: true });
  buildExtension();

  if (args.includes('--package')) {
    const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const zipPath = resolve(outputDir, `doc-copilot-v${version}-chrome.zip`);
    if (process.platform === 'win32') {
      run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $env:DOC_COPILOT_DIST | Select-Object -ExpandProperty FullName) -DestinationPath $env:DOC_COPILOT_ZIP -Force",
      ], { env: { ...process.env, DOC_COPILOT_DIST: distDir, DOC_COPILOT_ZIP: zipPath } });
    } else {
      // Remove an old archive so zip cannot retain obsolete extension files.
      await rm(zipPath, { force: true });
      run('zip', ['-r', '-q', zipPath, '.'], { cwd: distDir });
    }
    console.log(`Package complete: ${zipPath}`);
  }

  if (args.includes('--watch')) {
    let timer;
    const scheduleBuild = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          buildExtension();
        } catch (error) {
          console.error(error.message);
        }
      }, 250);
    };
    for (const dir of ['src', 'public']) {
      watch(resolve(root, dir), { recursive: true }, scheduleBuild);
    }
    for (const file of ['vite.config.ts', 'package.json']) {
      watch(resolve(root, file), scheduleBuild);
    }
    console.log('Watching src/, public/, vite.config.ts and package.json. Press Ctrl+C to stop.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
