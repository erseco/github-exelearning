// End-to-end: the real Worker (wrangler dev) and the real editor in Chromium, with GitHub faked
// from test/fixture (a disposable clone of exelearning-style-book) as the repository teacher/libro.
// Usage: npm run fetch-editor && npm run fixture && npm run test:e2e   (HEADED=1 to watch)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 8811;
const APP = `http://localhost:${PORT}`;
const EDITOR = `http://127.0.0.1:${PORT}`;
const FIXTURE = new URL('fixture/', import.meta.url).pathname;
const MARKER = `Edited from GitHub ${Date.now()}`;
const shots = new URL('../dist/e2e-', import.meta.url).pathname;
const step = (name) => console.log(`✔ ${name}`);

// --- Fake GitHub: teacher/libro at commit c1, plus a log of every write. -----------------------
const files = new Map();
const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir)) {
        if (name === '.git') continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (statSync(join(dir, name)).isDirectory()) walk(join(dir, name), path);
        else files.set(path, readFileSync(join(dir, name)));
    }
};
walk(FIXTURE);
// Real git blob SHAs, so unchanged published files are recognized.
const sha = (path) => createHash('sha1').update(`blob ${files.get(path).length}\0`).update(files.get(path)).digest('hex');
const writes = [];
let blobs = 0;

async function github(route) {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    }
    const path = url.pathname;
    if (url.hostname === 'raw.githubusercontent.com') {
        const file = decodeURIComponent(path.split('/').slice(4).join('/'));
        return files.has(file) ? route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: files.get(file) }) : route.fulfill({ status: 404 });
    }
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    if (request.method() !== 'GET') writes.push({ method: request.method(), path, body, auth: request.headers().authorization });
    if (path === '/repos/teacher/libro') return json({ id: 42, private: false, has_pages: true, default_branch: 'main', owner: { id: 7 } });
    if (path === '/repos/teacher/libro/branches/main') return json({ protected: false, commit: { sha: 'c1', commit: { tree: { sha: 't1' } } } });
    if (path === '/repos/teacher/libro/git/trees/t1') {
        return json({ truncated: false, tree: [...files.keys()].map((p) => ({ path: p, type: 'blob', mode: '100644', sha: sha(p) })) });
    }
    const blob = path.match(/^\/repos\/teacher\/libro\/git\/blobs\/([0-9a-f]{40})$/);
    if (blob) {
        const file = [...files.keys()].find((p) => sha(p) === blob[1]);
        return file ? json({ sha: blob[1], encoding: 'base64', content: files.get(file).toString('base64') }) : json({ message: 'Not Found' }, 404);
    }
    if (path === '/user') return json({ login: 'teacher' });
    if (path === '/user/installations') return json({ installations: [{ id: 1, account: { login: 'teacher' }, repository_selection: 'all' }] });
    if (path === '/user/installations/1/repositories') {
        const repo = (name, pushed) => ({ full_name: `teacher/${name}`, name, owner: { login: 'teacher' }, private: name === 'notas', default_branch: 'main', pushed_at: pushed });
        return json({ repositories: [repo('notas', '2026-10-09T10:00:00Z'), repo('libro', '2026-10-01T10:00:00Z')] });
    }
    if (path === '/repos/teacher/libro/git/trees/main') return json({ tree: [...files.keys()].map((p) => ({ path: p, type: 'blob', sha: sha(p) })) });
    if (path === '/repos/teacher/notas/git/trees/main') return json({ tree: [{ path: 'README.md', type: 'blob' }] });
    if (path === '/repos/teacher/libro/git/refs') return json({ ref: body.ref });
    if (path === '/repos/teacher/libro/pulls') return json({ html_url: 'https://github.com/teacher/libro/pull/1' });
    if (path === '/repos/teacher/libro/git/blobs') return json({ sha: `blob${++blobs}` });
    if (path === '/repos/teacher/libro/git/trees') return json({ sha: 't2' });
    if (path === '/repos/teacher/libro/git/commits') return json({ sha: 'c2', html_url: 'https://github.com/teacher/libro/commit/c2' });
    if (path === '/repos/teacher/libro/git/refs/heads/main') return json({});
    return json({ message: `Not faked: ${request.method()} ${path}` }, 404);
}

// --- Run ----------------------------------------------------------------------------------------
const build = spawn('npm', ['run', 'build'], { env: { ...process.env, APP_ORIGINS: APP }, stdio: 'inherit' });
assert.equal(await new Promise((r) => build.on('exit', r)), 0, 'build failed');
const worker = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--var', `APP_ORIGIN:${APP}`, '--var', `EDITOR_ORIGIN:${EDITOR}`,
    '--var', 'GITHUB_CLIENT_ID:test-client', '--var', 'GITHUB_APP_SLUG:exelearning-test'], { stdio: 'inherit' });
// Wait until the Worker answers (its log format differs between terminals and CI).
let exited = false;
worker.on('exit', () => (exited = true));
for (let i = 0; ; i++) {
    if (exited || i > 120) throw new Error('wrangler dev did not start');
    if (await fetch(`${EDITOR}/api/github/config`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 1000));
}

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'en-US' });
    const csp = [];
    context.on('console', (m) => /Content Security Policy/.test(m.text()) && csp.push(m.text()));
    await context.route(/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//, github);
    await context.route(/^https:\/\/github\.com\/login\/oauth\/authorize/, (route) => {
        const state = new URL(route.request().url()).searchParams.get('state');
        return route.fulfill({ status: 302, headers: { Location: `${APP}/auth/callback.html?code=test-code&state=${state}` } });
    });
    let exchanged;
    await context.route(`${APP}/api/github/token`, (route) => {
        exchanged = JSON.parse(route.request().postData());
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'test-token', expires_in: 28800, refresh_token: 'r' }) });
    });
    const page = await context.newPage();
    page.on('console', (m) => process.env.DEBUG && console.log(`[${m.type()}] ${m.text().slice(0, 300)}`));
    page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

    // The README badge link.
    await page.goto(`${APP}/?repo=teacher/libro`);
    await page.locator('#bar').waitFor().catch(async (error) => {
        console.log('landing message:', await page.locator('#message').innerText());
        throw error;
    });
    const frame = page.frameLocator('#editor iframe');
    await page.locator('#save:not([disabled])').waitFor({ timeout: 120_000 });
    const editorFrame = page.frames().find((f) => f.url().startsWith(`${EDITOR}/editor/embed`));
    assert.ok(editorFrame, 'editor frame on the editor origin');
    assert.equal(await page.evaluate(() => { try { return !!document.querySelector('#editor iframe').contentWindow.document; } catch { return false; } }), false, 'the app cannot reach into the editor (different origin)');
    step('the badge URL opens teacher/libro in the official editor, on its own origin');

    await frame.locator('.modal.show button', { hasText: /^Yes$/ }).click();
    await frame.locator('#nav_list').getByText('Inicio', { exact: true }).first().click();
    const idevice = frame.locator('.idevice_node#SP00000003');
    await editorFrame.waitForFunction(() => {
        const text = document.querySelector('.idevice_node#SP00000003 strong');
        return text && getComputedStyle(text).fontFamily.includes('Literata');
    }, null, { timeout: 30_000 });
    await editorFrame.waitForFunction(() => [...document.querySelectorAll('#node-content img')].every((img) => img.complete && img.naturalWidth > 0));
    await page.screenshot({ path: `${shots}1-opened.png` });
    step('the custom Book style from theme/ and the images from content/resources/ load');

    await idevice.locator('button', { hasText: 'Edit' }).first().click();
    await frame.frameLocator('#textTextarea_ifr').locator('body p').nth(1).click();
    await page.keyboard.press('Home');
    await page.keyboard.type(`${MARKER} `);
    await idevice.locator('button', { hasText: 'Save' }).first().click();
    await idevice.getByText(MARKER).waitFor();
    await page.locator('#status.dirty').waitFor();
    step(`editing marks the project as modified: "${await page.locator('#status').innerText()}"`);

    // Ctrl/Cmd+S inside the editor opens the save dialog.
    await idevice.click({ position: { x: 5, y: 5 } });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
    await page.locator('#save-dialog[open]').waitFor();
    // The fixture commits its exported website, so saving it too is offered and checked.
    assert.ok(await page.locator('#write-site').isChecked());
    let listed = await page.locator('#save-files li').allInnerTexts();
    assert.ok(listed.includes('index.html') && listed.at(-1) === 'content.xml', 'the website is listed, content.xml last');
    assert.ok(!listed.some((p) => p.startsWith('theme/')), 'the theme is never written');
    await page.locator('#write-site').uncheck();
    listed = await page.locator('#save-files li').allInnerTexts();
    assert.deepEqual(listed, ['content.xml']);
    await page.locator('#write-site').check();
    listed = await page.locator('#save-files li').allInnerTexts();
    await page.locator('#site-info').click();
    await page.locator('#site-help:popover-open').waitFor();
    assert.match(await page.locator('#site-help').innerText(), /Pages workflow/);
    await page.screenshot({ path: `${shots}2b-site-help.png` });
    await page.locator('#site-help-close').click();
    await page.locator('#site-help:popover-open').waitFor({ state: 'detached' });
    assert.ok(await page.locator('#write-site').isChecked(), 'the info button does not toggle the option');
    await page.screenshot({ path: `${shots}2-save-dialog.png` });
    step('Ctrl/Cmd+S opens "Save to GitHub" with content.xml and, checked by default, the changed website files');

    const popup = page.waitForEvent('popup');
    await page.locator('#confirm-save').click();
    await popup;
    await page.locator('#status', { hasText: 'Saved' }).waitFor({ timeout: 60_000 });
    await page.locator('#toast a').waitFor();
    await page.screenshot({ path: `${shots}3-saved.png` });

    assert.equal(exchanged.code, 'test-code');
    assert.ok(exchanged.code_verifier && exchanged.repository_id === 42, 'PKCE verifier and repository restriction are sent');
    const tree = writes.find((w) => w.path.endsWith('/git/trees'));
    const paths = tree.body.tree.map((e) => e.path);
    assert.deepEqual(paths, listed);
    assert.equal(tree.body.base_tree, 't1');
    assert.equal(writes.filter((w) => w.path.endsWith('/git/blobs')).length, paths.length);
    const blobs = writes.filter((w) => w.path.endsWith('/git/blobs')).map((w) => Buffer.from(w.body.content, 'base64').toString());
    assert.ok(blobs.some((b) => b.includes(MARKER) && b.includes('<html')), 'the website contains the edit');
    const content = blobs.find((b) => b.includes('<ode'));
    assert.ok(content.includes(MARKER), 'the commit contains the edit');
    assert.ok(!content.includes('pp_screenshot'), 'no duplicated screenshot in content.xml');
    assert.deepEqual(writes.find((w) => w.path.endsWith('/git/commits')).body.parents, ['c1']);
    assert.deepEqual(writes.find((w) => w.method === 'PATCH').body, { sha: 'c2', force: false });
    assert.ok(writes.every((w) => w.auth === 'Bearer test-token'));
    assert.equal(await page.locator('#status.dirty').count(), 0);
    step('login (PKCE, token limited to the repository) and one commit with content.xml and the website, fast-forward on main');

    writes.length = 0;
    await page.locator('#save').click();
    await page.locator('#toast', { hasText: 'No changes' }).waitFor();
    assert.equal(writes.length, 0);
    step('saving again without changes writes nothing');

    // A second change, proposed as a pull request.
    await idevice.locator('button', { hasText: 'Edit' }).first().click();
    await frame.frameLocator('#textTextarea_ifr').locator('body p').nth(1).click();
    await page.keyboard.type('PR ');
    await idevice.locator('button', { hasText: 'Save' }).first().click();
    await page.locator('#status.dirty').waitFor();
    writes.length = 0;
    await page.locator('#save').click();
    await page.locator('#save-dialog[open]').waitFor();
    assert.equal(await page.locator('#branch-label').innerText(), 'Commit directly to the main branch');
    await page.locator('#to-pr').check();
    await page.screenshot({ path: `${shots}4-save-as-pr.png` });
    await page.locator('#confirm-save').click();
    await page.locator('#toast', { hasText: 'Pull request opened' }).waitFor({ timeout: 60_000 });
    const ref = writes.find((w) => w.path.endsWith('/git/refs'));
    assert.match(ref.body.ref, /^refs\/heads\/exelearning\/edit-\d{14}$/);
    assert.deepEqual(writes.find((w) => w.path.endsWith('/git/commits')).body.parents, ['c2']);
    assert.equal(writes.find((w) => w.path.endsWith('/pulls')).body.base, 'main');
    assert.ok(!writes.some((w) => w.method === 'PATCH'), 'main is not touched');
    assert.equal(await page.locator('#toast a').getAttribute('href'), 'https://github.com/teacher/libro/pull/1');
    assert.match(await page.locator('#repo-link').innerText(), /teacher\/libro · exelearning\/edit-\d{14}/);
    step('"Create a branch … and start a pull request" opens a PR from the last commit, without touching main');

    // Publish on GitHub Pages: a prefilled "new file" link on GitHub and the Pages settings.
    await page.locator('.menu summary').click();
    await page.locator('#pages').click();
    await page.locator('#pages-dialog[open]').waitFor();
    const workflowLink = new URL(await page.locator('#pages-workflow').getAttribute('href'));
    assert.equal(workflowLink.origin + workflowLink.pathname, 'https://github.com/teacher/libro/new/main');
    assert.match(workflowLink.searchParams.get('value'), /branches: \[main\]/);
    assert.equal(workflowLink.searchParams.get('filename'), '.github/workflows/exelearning-pages.yml');
    assert.match(workflowLink.searchParams.get('value'), /PROJECT_DIR: \. /);
    assert.equal(await page.locator('#pages-settings').getAttribute('href'), 'https://github.com/teacher/libro/settings/pages');
    assert.equal(await page.locator('#pages-result a').innerText(), 'https://teacher.github.io/libro/');
    await page.screenshot({ path: `${shots}5-pages.png` });
    await page.locator('#pages-close').click();
    step('"Publish on GitHub Pages" links to a prefilled workflow and the Pages settings');
    assert.equal(await page.locator('#site-link').getAttribute('href'), 'https://teacher.github.io/libro/');
    assert.ok(await page.locator('#site-link').isVisible());
    step('"View website" links to the published site when Pages is enabled');

    // Landing page while signed in: the repositories the app can reach, resources first.
    await page.goto(APP);
    const card = page.locator('#repos li.card');
    await card.locator('.title', { hasText: 'El ciclo del agua · Libro' }).waitFor();
    await card.locator('img.shot').waitFor();
    assert.match(await card.locator('.meta').innerText(), /^teacher\/libro · root/);
    await page.locator('#other-summary', { hasText: 'Repositories without eXeLearning resources (1)' }).waitFor();
    assert.equal(await page.locator('#repos li.searching').count(), 0);
    assert.equal(await page.locator('#repos-summary').innerText(), '1 resource(s) in 1 repositories · signed in as teacher');
    assert.equal(await page.locator('#repos-box #open-form.compact label').innerText(), 'Is the resource in another repository?');
    await page.screenshot({ path: `${shots}6-your-resources-grid.png` });
    await page.locator('#view-list').click();
    assert.equal(await page.locator('#repos').getAttribute('class'), 'list');
    await page.screenshot({ path: `${shots}7-your-resources-list.png` });
    await page.reload();
    await card.locator('a.edit').waitFor();
    assert.equal(await page.locator('#view-list').getAttribute('aria-pressed'), 'true', 'the view choice is remembered');
    await card.locator('a.edit').click();
    await page.waitForURL(/\?repo=teacher%2Flibro/);
    await page.locator('#save:not([disabled])').waitFor({ timeout: 120_000 });
    step('"Your eXeLearning resources": a card with the title and screenshot, grid/list toggle remembered, repositories without resources apart; Edit opens it');

    // Signed out: the landing page offers to sign in, and the box accepts a repository URL.
    await page.goto(APP);
    await page.locator('#logout-landing').click();
    await page.locator('#signin').waitFor();
    assert.equal(await page.locator('#divider').isVisible(), true);
    await page.screenshot({ path: `${shots}8-signed-out.png` });
    const signinPopup = page.waitForEvent('popup');
    await page.locator('#signin').click();
    await signinPopup;
    await page.locator('#repos li.card a.edit').waitFor();
    step('signing in from the landing page lists the resources');
    await page.locator('#repo-input').fill('https://github.com/teacher/libro');
    await page.locator('#open-button').click();
    await page.waitForURL(/\?repo=teacher%2Flibro/);
    await page.locator('#save:not([disabled])').waitFor({ timeout: 120_000 });
    step('"Open from GitHub" accepts a repository URL (signed in: files come from the authenticated API)');

    console.log(`\nE2E passed (${csp.length} CSP violations)`);
    for (const message of new Set(csp)) console.log(`  CSP: ${message.slice(0, 220)}`);
} finally {
    await browser.close();
    worker.kill();
}
