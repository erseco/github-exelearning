import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Files } from '../../src/elpx.ts';
import { classify, planSave } from '../../src/sync.ts';

const b = (s: string) => new TextEncoder().encode(s);
const files = (entries: Record<string, string>): Files => new Map(Object.entries(entries).map(([k, v]) => [k, b(v)]));

test('classify separates source, published and protected files', () => {
    assert.equal(classify('content.xml'), 'source');
    assert.equal(classify('screenshot.png'), 'source');
    assert.equal(classify('content/resources/a/b.jpg'), 'source');
    for (const p of ['index.html', 'html/p.html', 'libs/common.js', 'idevices/text/text.js', 'content/css/base.css', 'search_index.js', 'custom/x.css', 'content.dtd']) {
        assert.equal(classify(p), 'published', p);
    }
    assert.equal(classify('theme/style.css'), 'protected');
});

test('planSave writes changed source files only, content.xml last', () => {
    const opened = files({ 'content.xml': 'v1', 'content/resources/a.jpg': 'A', 'theme/style.css': 'T' });
    const current = files({ 'content.xml': 'v1', 'content/resources/a.jpg': 'A', 'theme/style.css': 'T', 'index.html': 'old' });
    const exported = files({
        'content.xml': 'v2',
        'content/resources/a.jpg': 'A',
        'content/resources/new.png': 'N',
        'theme/style.css': 'T2',
        'index.html': 'new',
        'html/p.html': 'P',
    });
    const plan = planSave(exported, current, opened);
    assert.deepEqual(plan.write, ['content/resources/new.png', 'content.xml']);
    assert.deepEqual(plan.stale.sort(), ['html/p.html', 'index.html', 'theme/style.css']);
    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.conflicts, []);
    assert.deepEqual(plan.removed, []);
});

test('planSave can include published files but never the theme', () => {
    const plan = planSave(files({ 'index.html': 'new', 'theme/style.css': 'T2', 'content.xml': 'x' }), files({ 'content.xml': 'x' }), files({}), true);
    assert.deepEqual(plan.write, ['index.html']);
    assert.deepEqual(plan.stale, ['theme/style.css']);
});

test('planSave reports workspace changes made after opening as conflicts', () => {
    const opened = files({ 'content.xml': 'v1', 'content/resources/a.jpg': 'A' });
    const current = files({ 'content.xml': 'edited elsewhere', 'content/resources/a.jpg': 'A', 'content/resources/b.jpg': 'B?' });
    const exported = files({ 'content.xml': 'v2', 'content/resources/a.jpg': 'A', 'content/resources/b.jpg': 'B' });
    const plan = planSave(exported, current, opened);
    assert.deepEqual(plan.conflicts.sort(), ['content.xml', 'content/resources/b.jpg']);
});

test('planSave lists source files the project no longer contains, never other files', () => {
    const opened = files({ 'content.xml': 'v1', 'content/resources/old.jpg': 'O', 'content/resources/gone.jpg': 'G', 'theme/x.css': 'X', 'custom/c.css': 'C' });
    const current = files({ 'content.xml': 'v1', 'content/resources/old.jpg': 'O', 'theme/x.css': 'X', 'custom/c.css': 'C', 'README.md': 'R' });
    const plan = planSave(files({ 'content.xml': 'v2' }), current, opened);
    assert.deepEqual(plan.removed, ['content/resources/old.jpg']);
    assert.deepEqual(plan.write, ['content.xml']);
});

test('planSave with no edits writes nothing', () => {
    const same = files({ 'content.xml': 'v1', 'content/resources/a.jpg': 'A' });
    const plan = planSave(same, same, same);
    assert.deepEqual(plan.write, []);
    assert.equal(plan.unchanged, 2);
});
