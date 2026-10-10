// Build dist/: the app, the official editor (editor/) and editor/embed.html (editor + embedding
// config + adapter). APP_ORIGINS lists the app origins allowed to embed and drive the editor.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const appOrigins = (process.env.APP_ORIGINS ?? 'https://github.exelearning.dev').split(',');
if (!existsSync('editor/index.html')) throw new Error('The editor is missing: run "npm run fetch-editor" first.');

rmSync('dist', { recursive: true, force: true });
cpSync('public', 'dist', { recursive: true });
cpSync('editor', 'dist/editor', { recursive: true });

const config = {
    basePath: '/editor', // the editor files live under /editor/ on the editor origin (preview service worker included)
    parentOrigin: appOrigins[0],
    trustedOrigins: appOrigins,
    // The app owns opening and saving.
    hideUI: { fileMenu: true, saveButton: true, userMenu: true },
};
const html = readFileSync('editor/index.html', 'utf8')
    // Must run before any editor script reads it.
    .replace(/<head>/i, `<head>\n<script>window.__EXE_EMBEDDING_CONFIG__ = ${JSON.stringify(config)};</script>`)
    .replace(/<\/body>/i, '<script src="./embed-adapter.js"></script>\n</body>');
if (!html.includes('__EXE_EMBEDDING_CONFIG__') || !html.includes('embed-adapter.js')) throw new Error('Unexpected editor/index.html');
writeFileSync('dist/editor/embed.html', html);

// Security headers for the editor files (served without the Worker). Only the app may frame it,
// and the project content it renders cannot send data anywhere with fetch/XHR.
writeFileSync(
    'dist/_headers',
    `/editor/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; font-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob: data: https:; object-src 'none'; frame-ancestors ${appOrigins.join(' ')}
`,
);

await esbuild.build({
    entryPoints: { app: 'src/app/main.ts', 'auth-callback': 'src/app/auth-callback.ts', setup: 'src/app/setup.ts', 'editor/embed-adapter': 'src/editor/adapter.ts' },
    outdir: 'dist',
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    sourcemap: true,
    logLevel: 'info',
});
