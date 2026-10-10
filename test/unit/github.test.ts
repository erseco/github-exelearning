import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createApi, findProjects, listAccessibleRepos, loadProject, pagesWorkflow, parseTarget, saveProject, type Project } from '../../src/app/github.ts';
import { planSave } from '../../src/sync.ts';
import { exchangeToken } from '../../worker/index.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const params = (q: string) => new URLSearchParams(q);

test('parseTarget accepts owner/name, parameters and GitHub URLs', () => {
    assert.deepEqual(parseTarget(params('repo=ate/libro')), { owner: 'ate', repo: 'libro', branch: undefined, path: '' });
    assert.deepEqual(parseTarget(params('repo=ate/libro&branch=dev&path=docs/curso/')), { owner: 'ate', repo: 'libro', branch: 'dev', path: 'docs/curso' });
    assert.deepEqual(parseTarget(params('gh=https://github.com/ate/libro.git')), { owner: 'ate', repo: 'libro', branch: undefined, path: '' });
    assert.deepEqual(parseTarget(params('url=https://github.com/ate/libro/tree/main/recurso/uno')), { owner: 'ate', repo: 'libro', branch: 'main', path: 'recurso/uno' });
    for (const bad of ['', 'repo=ate', 'repo=../x/y', 'repo=ate/libro&path=../etc', 'repo=https://evil.com/a/b']) {
        assert.equal(parseTarget(params(bad)), undefined, bad);
    }
});

/** A tiny GitHub: one repository whose branch head can move, recording every write. */
function fakeGitHub(files: Record<string, string>, options: { protectedBranch?: boolean; moveHeadTouching?: string } = {}) {
    const calls: { method: string; path: string; body: any }[] = [];
    let head = { sha: 'c1', tree: 't1' };
    let moved = false;
    const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body });
        const p = url.pathname;
        if (url.hostname === 'raw.githubusercontent.com') {
            const file = decodeURIComponent(p.split('/').slice(4).join('/'));
            return file in files ? new Response(enc(files[file])) : new Response('', { status: 404 });
        }
        if (p === '/repos/o/r') return respond({ id: 7, private: false, default_branch: 'main', owner: { id: 3 } });
        if (p === '/repos/o/r/branches/main') return respond({ protected: !!options.protectedBranch, commit: { sha: head.sha, commit: { tree: { sha: head.tree } } } });
        if (p === '/repos/o/r/git/trees/t1') {
            return respond({ truncated: false, tree: Object.keys(files).map((path) => ({ path, type: 'blob', mode: '100644', sha: `sha-${path}` })) });
        }
        if (p === '/repos/o/r/git/blobs') return respond({ sha: `blob-${calls.length}` });
        if (p === '/repos/o/r/git/trees') return respond({ sha: `tree-${calls.length}` });
        if (p === '/repos/o/r/git/commits') return respond({ sha: `commit-${calls.length}`, html_url: 'https://github.com/o/r/commit/x' });
        if (p === '/repos/o/r/git/refs/heads/main' && method === 'PATCH') {
            if (options.protectedBranch) return respond({ message: 'Protected branch update failed for refs/heads/main.' }, 422);
            if (options.moveHeadTouching !== undefined && !moved) {
                moved = true;
                head = { sha: 'c2', tree: 't2' };
                return respond({ message: 'Update is not a fast forward' }, 422);
            }
            return respond({});
        }
        if (p === '/repos/o/r/compare/c1...c2') return respond({ files: [{ filename: options.moveHeadTouching }] });
        if (p === '/repos/o/r/git/refs') return respond({});
        if (p === '/repos/o/r/pulls') return respond({ html_url: 'https://github.com/o/r/pull/1' });
        return respond({ message: `unexpected ${method} ${p}` }, 500);
    }) as typeof fetch;
    return { calls, fetchImpl, api: createApi('token', fetchImpl) };
}

const repoFiles = {
    'README.md': 'readme',
    'curso/content.xml': '<ode>v1</ode>',
    'curso/content/resources/a.jpg': 'A',
    'curso/content/resources/old.jpg': 'O',
    'curso/theme/style.css': 'css',
    'curso/html/index.html': '<html>',
    'curso/.github/x': 'hidden',
    'otro/content.xml': '<ode/>',
};

test('loadProject reads only the import files of the project folder, anonymously from raw', async () => {
    const gh = fakeGitHub(repoFiles);
    const project = await loadProject(createApi(undefined, gh.fetchImpl), { owner: 'o', repo: 'r', path: 'curso' }, false, gh.fetchImpl);
    assert.deepEqual([...project.files.keys()].sort(), ['content.xml', 'content/resources/a.jpg', 'content/resources/old.jpg', 'theme/style.css']);
    assert.equal(new TextDecoder().decode(project.files.get('content.xml')), '<ode>v1</ode>');
    assert.deepEqual([project.branch, project.commitSha, project.treeSha, project.repoId, project.ownerId], ['main', 'c1', 't1', 7, 3]);
    assert.ok(gh.calls.filter((c) => c.path.includes('/git/blobs/')).length === 0, 'public files come from raw, not the API');

    const root = await loadProject(createApi(undefined, gh.fetchImpl), { owner: 'o', repo: 'r', path: '' }, false, gh.fetchImpl);
    assert.equal(root.files.size, 0);
    assert.deepEqual(root.candidates.sort(), ['curso', 'otro']);
});

async function editedProject(gh: ReturnType<typeof fakeGitHub>) {
    const project: Project = await loadProject(gh.api, { owner: 'o', repo: 'r', path: 'curso' }, false, gh.fetchImpl);
    const exported = new Map(project.files);
    exported.set('content.xml', enc('<ode>v2</ode>'));
    exported.set('content/resources/new.png', enc('N'));
    exported.delete('content/resources/old.jpg');
    exported.set('theme/style.css', enc('regenerated'));
    gh.calls.length = 0;
    return { project, exported, plan: planSave(exported, project.files, project.files) };
}

test('saveProject writes one commit with only the source changes and fast-forwards the branch', async () => {
    const gh = fakeGitHub(repoFiles);
    const { project, exported, plan } = await editedProject(gh);
    const result = await saveProject(gh.api, project, plan, exported, { message: 'Edit', pullRequest: false, deleteRemoved: true });
    assert.equal(result.kind, 'commit');
    const tree = gh.calls.find((c) => c.path === '/repos/o/r/git/trees' && c.method === 'POST')?.body;
    assert.equal(tree.base_tree, 't1');
    assert.deepEqual(tree.tree.map((e: any) => [e.path, e.sha === null ? 'deleted' : 'blob']).sort(), [
        ['curso/content.xml', 'blob'],
        ['curso/content/resources/new.png', 'blob'],
        ['curso/content/resources/old.jpg', 'deleted'],
    ]);
    const commit = gh.calls.find((c) => c.path === '/repos/o/r/git/commits')?.body;
    assert.deepEqual(commit.parents, ['c1']);
    assert.equal(gh.calls.find((c) => c.method === 'PATCH')?.body.force, false);
    assert.ok(!gh.calls.some((c) => c.path.endsWith('/pulls')));
});

test('saveProject keeps removed files unless asked', async () => {
    const gh = fakeGitHub(repoFiles);
    const { project, exported, plan } = await editedProject(gh);
    await saveProject(gh.api, project, plan, exported, { message: 'Edit', pullRequest: false, deleteRemoved: false });
    const tree = gh.calls.find((c) => c.path === '/repos/o/r/git/trees' && c.method === 'POST')?.body;
    assert.ok(!tree.tree.some((e: any) => e.sha === null));
});

test('saveProject rebases onto a moved branch when other files changed', async () => {
    const gh = fakeGitHub(repoFiles, { moveHeadTouching: 'README.md' });
    const { project, exported, plan } = await editedProject(gh);
    const result = await saveProject(gh.api, project, plan, exported, { message: 'Edit', pullRequest: false, deleteRemoved: false });
    assert.equal(result.kind, 'commit');
    const commits = gh.calls.filter((c) => c.path === '/repos/o/r/git/commits').map((c) => c.body.parents[0]);
    assert.deepEqual(commits, ['c1', 'c2']);
    assert.equal(gh.calls.filter((c) => c.path === '/repos/o/r/git/trees' && c.method === 'POST')[1].body.base_tree, 't2');
});

test('saveProject opens a pull request when the same files changed meanwhile', async () => {
    const gh = fakeGitHub(repoFiles, { moveHeadTouching: 'curso/content.xml' });
    const { project, exported, plan } = await editedProject(gh);
    const result = await saveProject(gh.api, project, plan, exported, { message: 'Edit', pullRequest: false, deleteRemoved: false });
    assert.equal(result.kind, 'pull-request');
    assert.equal(result.url, 'https://github.com/o/r/pull/1');
});

test('saveProject opens a pull request for protected branches or when asked', async () => {
    for (const [options, pullRequest] of [[{ protectedBranch: true }, false], [{}, true]] as const) {
        const gh = fakeGitHub(repoFiles, options);
        const { project, exported, plan } = await editedProject(gh);
        const result = await saveProject(gh.api, project, plan, exported, { message: 'Edit', pullRequest, deleteRemoved: false });
        assert.equal(result.kind, 'pull-request');
        const ref = gh.calls.find((c) => c.path === '/repos/o/r/git/refs')?.body;
        assert.match(ref.ref, /^refs\/heads\/exelearning\/edit-\d{14}$/);
        const pr = gh.calls.find((c) => c.path === '/repos/o/r/pulls')?.body;
        assert.equal(pr.base, 'main');
        assert.equal(result.branch, ref.ref.replace('refs/heads/', ''));
    }
});

test('the token endpoint only serves the app, sends the secret to GitHub and returns token fields', async () => {
    const env = {
        ASSETS: { fetch: async () => new Response('') },
        APP_ORIGIN: 'https://app.test',
        EDITOR_ORIGIN: 'https://editor.test',
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
    };
    let sent: URLSearchParams | undefined;
    const github = (async (_url: string, init: RequestInit) => {
        sent = init.body as URLSearchParams;
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 28800, refresh_token: 'ref', scope: '', extra: 'x' }));
    }) as typeof fetch;
    const post = (body: unknown, origin = 'https://app.test') =>
        new Request('https://app.test/api/github/token', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) });

    assert.equal((await exchangeToken(post({ code: 'c' }, 'https://editor.test'), env, github)).status, 403);
    assert.equal((await exchangeToken(post({}), env, github)).status, 400);

    const response = await exchangeToken(post({ code: 'c', code_verifier: 'v', redirect_uri: 'https://app.test/auth/callback.html', repository_id: 7 }), env, github);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { access_token: 'tok', expires_in: 28800, refresh_token: 'ref' });
    assert.deepEqual(Object.fromEntries(sent as URLSearchParams), {
        client_id: 'id', client_secret: 'secret', code: 'c', code_verifier: 'v', redirect_uri: 'https://app.test/auth/callback.html', repository_id: '7',
    });

    await exchangeToken(post({ code: 'c', redirect_uri: 'https://evil.test/cb' }), env, github);
    assert.equal(sent?.get('redirect_uri'), null);
    await exchangeToken(post({ refresh_token: 'ref' }), env, github);
    assert.equal(sent?.get('grant_type'), 'refresh_token');
    assert.equal((await exchangeToken(post({ code: 'c' }), { ...env, GITHUB_CLIENT_SECRET: undefined }, github)).status, 501);
});

test('listAccessibleRepos merges installations and pages, newest push first', async () => {
    const repo = (name: string, pushed: string) => ({ full_name: `o/${name}`, name, owner: { login: 'o' }, private: name === 'b', default_branch: 'main', pushed_at: pushed });
    const pages: Record<string, unknown> = {
        '/user/installations': { installations: [{ id: 1 }, { id: 2 }] },
        '/user/installations/1/repositories?page=1': { repositories: [repo('a', '2026-01-01'), ...Array.from({ length: 99 }, (_, i) => repo(`x${i}`, '2025-01-01'))] },
        '/user/installations/1/repositories?page=2': { repositories: [repo('b', '2026-03-01')] },
        '/user/installations/2/repositories?page=1': { repositories: [repo('a', '2026-01-01')] },
    };
    const fetchImpl = (async (input: string | URL) => {
        const url = new URL(String(input));
        const key = url.pathname + (url.searchParams.get('page') ? `?page=${url.searchParams.get('page')}` : '');
        return new Response(JSON.stringify(pages[key] ?? {}), { status: key in pages ? 200 : 404 });
    }) as typeof fetch;
    const repos = await listAccessibleRepos(createApi('t', fetchImpl));
    assert.equal(repos.length, 101);
    assert.deepEqual(repos.slice(0, 2).map((r) => [r.repo, r.private]), [['b', true], ['a', false]]);
});

test('findProjects lists folders with content.xml, skipping hidden folders and empty repositories', async () => {
    const tree = { tree: ['content.xml', 'curso/uno/content.xml', '.github/content.xml', 'node_modules/x/content.xml', 'docs/readme.md'].map((path) => ({ path, type: 'blob' })) };
    const ok = (async () => new Response(JSON.stringify(tree))) as typeof fetch;
    const summary = { owner: 'o', repo: 'r', private: false, defaultBranch: 'main', pushedAt: '' };
    assert.deepEqual(await findProjects(createApi('t', ok), summary), ['', 'curso/uno']);
    const empty = (async () => new Response(JSON.stringify({ message: 'Git Repository is empty.' }), { status: 409 })) as typeof fetch;
    assert.deepEqual(await findProjects(createApi('t', empty), summary), []);
});

test('pagesWorkflow fills the branch and the project folder', () => {
    const template = readFileSync(new URL('../../public/templates/exelearning-pages.yml', import.meta.url), 'utf8');
    const root = pagesWorkflow(template, 'main', '');
    assert.match(root, /branches: \[main\]/);
    assert.match(root, /PROJECT_DIR: \. /);
    assert.match(root, /- 'content\.xml'/);
    const sub = pagesWorkflow(template, 'dev', 'cursos/agua');
    assert.match(sub, /PROJECT_DIR: cursos\/agua /);
    assert.match(sub, /- 'cursos\/agua\/content\/resources\/\*\*'/);
    assert.ok(!sub.includes('__'));
});
