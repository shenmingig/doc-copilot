import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';

const target = process.env.BUILD_TARGET || 'all';
const outDir = resolve(__dirname, 'output/dist');

function copyStaticPlugin() {
  return {
    name: 'copy-extension-files',
    closeBundle() {
      const distDir = outDir;
      mkdirSync(resolve(distDir, 'licenses'), { recursive: true });
      copyFileSync(resolve(__dirname, 'node_modules/katex/LICENSE'), resolve(distDir, 'licenses/KaTeX-LICENSE.txt'));

      copyFileSync(
        resolve(__dirname, 'public/manifest.json'),
        resolve(distDir, 'manifest.json'),
      );

      copyFileSync(
        resolve(__dirname, 'src/popup/popup.html'),
        resolve(distDir, 'popup.html'),
      );

      copyFileSync(
        resolve(__dirname, 'src/offscreen/offscreen.html'),
        resolve(distDir, 'offscreen.html'),
      );

      const iconsDir = resolve(__dirname, 'public/icons');
      const distIconsDir = resolve(distDir, 'icons');
      mkdirSync(distIconsDir, { recursive: true });
      if (existsSync(iconsDir)) {
        for (const f of readdirSync(iconsDir)) {
          copyFileSync(resolve(iconsDir, f), resolve(distIconsDir, f));
        }
      }
    },
  };
}

function makeConfig(entry: string, outName: string, emptyOut: boolean, withCopy: boolean) {
  return defineConfig({
    // Chrome rejects content scripts that contain Unicode noncharacters (e.g. the
    // U+FFFF in KaTeX's lexer regex) as "not UTF-8 encoded". Keep output ASCII-only.
    esbuild: {
      charset: 'ascii',
    },
    build: {
      outDir,
      emptyOutDir: emptyOut,
      target: 'chrome110',
      minify: false,
      lib: {
        entry: resolve(__dirname, entry),
        formats: ['iife'],
        name: outName.replace(/-/g, '_'),
        fileName: () => `${outName}.js`,
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
          extend: true,
        },
      },
      sourcemap: process.env.NODE_ENV === 'development' ? 'inline' : false,
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@core': resolve(__dirname, 'src/core'),
        '@adapters': resolve(__dirname, 'src/adapters'),
        '@ui': resolve(__dirname, 'src/ui'),
      },
    },
    plugins: withCopy ? [copyStaticPlugin()] : [],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    },
  });
}

// Build targets selected by BUILD_TARGET env var
const configs: Record<string, ReturnType<typeof defineConfig>> = {
  content: makeConfig('src/content/index.ts', 'content', true, false),
  background: makeConfig('src/background/index.ts', 'background', false, false),
  popup: makeConfig('src/popup/popup.ts', 'popup', false, true),
  offscreen: makeConfig('src/offscreen/offscreen.ts', 'offscreen', false, false),
};

export default configs[target] || configs.content;
