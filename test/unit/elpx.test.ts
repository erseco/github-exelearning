import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { buildElpx, dropScreenshotProperty, type Files, IMPORT_DIRS, IMPORT_FILES, isSafePath, LIMITS, readElpx } from '../../src/elpx.ts';

const text = (s: string) => new TextEncoder().encode(s);
const CONTENT = text('<?xml version="1.0"?><ode></ode>');

test('isSafePath accepts project paths and rejects escapes', () => {
    for (const ok of ['content.xml', 'content/resources/a b.jpg', 'theme/fonts/x.woff2', 'html/página.html']) {
        assert.ok(isSafePath(ok), ok);
    }
    for (const bad of ['', '../x', 'a/../../x', '/etc/passwd', 'a//b', 'a/./b', './a', 'a/', 'C:/x', 'a\\b', 'a\0b']) {
        assert.ok(!isSafePath(bad), JSON.stringify(bad));
    }
});

test('buildElpx/readElpx round-trips binary files byte for byte', () => {
    const files: Files = new Map([
        ['content.xml', CONTENT],
        ['content/resources/photo.jpg', Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256)],
        ['screenshot.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 255])],
    ]);
    const back = readElpx(buildElpx(files));
    assert.deepEqual([...back.keys()].sort(), [...files.keys()].sort());
    for (const [path, bytes] of files) assert.deepEqual(back.get(path), bytes, path);
});

test('readElpx rejects path traversal and absolute entries', () => {
    for (const name of ['../evil.txt', 'content/../../evil.txt', '/abs.txt', 'a\\..\\b.txt']) {
        const zip = zipSync({ 'content.xml': CONTENT, [name]: text('x') });
        assert.throws(() => readElpx(zip), /Unsafe path/, name);
    }
});

test('readElpx enforces entry and size limits', () => {
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`content/resources/${i}.txt`, text('x')]));
    assert.throws(() => readElpx(zipSync({ 'content.xml': CONTENT, ...many }), { ...LIMITS, maxEntries: 10 }), /more than 10 entries/);
    const big = zipSync({ 'content.xml': CONTENT, 'content/resources/big.bin': new Uint8Array(2048) });
    assert.throws(() => readElpx(big, { ...LIMITS, maxFileBytes: 1024 }), /too large/);
    assert.throws(() => readElpx(big, { ...LIMITS, maxTotalBytes: 1024 }), /too large/);
});

test('readElpx never inflates beyond the declared size (zip bomb with a lying header)', () => {
    const zip = zipSync({ 'content.xml': CONTENT, 'bomb.bin': new Uint8Array(8 * 1024 * 1024) });
    // Rewrite the declared uncompressed size of bomb.bin in its central directory entry to 1 KiB.
    const view = new DataView(zip.buffer);
    for (let i = zip.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) !== 0x02014b50) continue;
        const nameLength = view.getUint16(i + 28, true);
        if (new TextDecoder().decode(zip.subarray(i + 46, i + 46 + nameLength)) === 'bomb.bin') view.setUint32(i + 24, 1024, true);
    }
    let files: Files | undefined;
    try {
        files = readElpx(zip);
    } catch {
        return; // rejecting the archive is fine too
    }
    assert.ok((files.get('bomb.bin')?.length ?? 0) <= 1024);
});

test('readElpx requires content.xml', () => {
    assert.throws(() => readElpx(zipSync({ 'index.html': text('<html>') })), /no content.xml/);
});

test('dropScreenshotProperty removes only the duplicated screenshot', () => {
    const xml = `<odeProperties>
  <odeProperty>
    <key>pp_title</key>
    <value>T</value>
  </odeProperty>
  <odeProperty>
    <key>pp_screenshot</key>
    <value>data:image/png;base64,iVBORw0KGgo=</value>
  </odeProperty>
  <odeProperty>
    <key>pp_lang</key>
    <value>es</value>
  </odeProperty>
</odeProperties>`;
    const out = new TextDecoder().decode(dropScreenshotProperty(text(xml)));
    assert.equal(out, xml.replace(/  <odeProperty>\n    <key>pp_screenshot[\s\S]*?<\/odeProperty>\n/, ''));
    assert.ok(out.includes('pp_title') && out.includes('pp_lang') && !out.includes('pp_screenshot'));
    const clean = text('<ode/>');
    assert.equal(dropScreenshotProperty(clean), clean);
});

test('the reference project round-trips through the import package (if test/fixture exists)', (t) => {
    const root = new URL('../fixture/', import.meta.url).pathname;
    try {
        statSync(join(root, 'content.xml'));
    } catch {
        t.skip('run "npm run fixture" first');
        return;
    }
    const files: Files = new Map();
    const walk = (dir: string) => {
        for (const name of readdirSync(join(root, dir))) {
            const path = `${dir}/${name}`;
            if (name.startsWith('.')) continue;
            if (statSync(join(root, path)).isDirectory()) walk(path);
            else files.set(path, readFileSync(join(root, path)));
        }
    };
    for (const path of IMPORT_FILES) files.set(path, readFileSync(join(root, path)));
    for (const dir of IMPORT_DIRS) {
        try {
            walk(dir);
        } catch {
            // optional folder
        }
    }
    const back = readElpx(buildElpx(files));
    assert.equal(back.size, files.size);
    for (const [path, bytes] of files) assert.ok(Buffer.from(bytes).equals(Buffer.from(back.get(path) as Uint8Array)), path);
    // Only what the importer reads: no README, scripts, .github, HTML or libs.
    assert.ok([...files.keys()].every((p) => p === 'content.xml' || p === 'screenshot.png' || /^(content\/resources|custom|theme)\//.test(p)));
});
