// Download the official eXeLearning static editor release into ./editor.
// Usage: node scripts/fetch-editor.mjs            (pinned release, checksum verified)
//        node scripts/fetch-editor.mjs <dir|zip>  (local static build, e.g. for testing upstream PRs)
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';

const VERSION = 'v4.0.6';
const SHA256 = 'ff40a4c51848fbf6faa3217c6b32df43d968e3773b14483089c8b733d188e869';
const RELEASE_URL = `https://github.com/exelearning/exelearning/releases/download/${VERSION}/exelearning-static-${VERSION}.zip`;
const out = new URL('../editor/', import.meta.url).pathname;
const source = process.argv[2];

rmSync(out, { recursive: true, force: true });
if (source && statSync(source).isDirectory()) {
    cpSync(source, out, { recursive: true });
} else {
    let zip;
    if (source) {
        zip = readFileSync(source);
    } else {
        const res = await fetch(RELEASE_URL);
        if (!res.ok) throw new Error(`Download failed: ${res.status} ${RELEASE_URL}`);
        zip = new Uint8Array(await res.arrayBuffer());
        const digest = createHash('sha256').update(zip).digest('hex');
        if (digest !== SHA256) throw new Error(`Checksum mismatch for ${RELEASE_URL}: ${digest}`);
    }
    // The release zip wraps everything in a top-level "static/" folder.
    for (const [name, data] of Object.entries(unzipSync(zip))) {
        const rel = name.replace(/^static\//, '');
        if (!rel || name.endsWith('/') || rel.split('/').includes('..')) continue;
        mkdirSync(dirname(join(out, rel)), { recursive: true });
        writeFileSync(join(out, rel), data);
    }
}
statSync(join(out, 'index.html'));
console.log(`eXeLearning editor ${source ?? VERSION} installed in ${out}`);
