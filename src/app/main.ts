// github.exelearning.dev: open an eXeLearning project from a GitHub repository in the official
// editor and save it back as a commit (or a pull request).
import { buildElpx, dropScreenshotProperty, type Files, readElpx } from '../elpx.ts';
import { planSave } from '../sync.ts';
import { type AppConfig, appCanAccess, currentToken, hasUsableToken, install, login, logout, openPopup } from './auth.ts';
import { EditorFrame } from './editor.ts';
import {
    type Api, blobBytes, createApi, findProjects, GitHubError, listAccessibleRepos, loadProject, pagesWorkflow, type Project, parseTarget, type RepoSummary,
    readTitle, type Resource, saveProject, type Target,
} from './github.ts';
import { lang, t } from './i18n.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let config: AppConfig;
let project: Project | undefined;
let editor: EditorFrame | undefined;
let dirty = false;
let saving = false;

function toast(text: string, link?: { href: string; label: string }, action?: { label: string; run(): void }) {
    const box = $('toast');
    box.replaceChildren(text);
    if (link) box.append(Object.assign(document.createElement('a'), { href: link.href, target: '_blank', rel: 'noopener', textContent: link.label }));
    if (action) {
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: action.label });
        button.onclick = () => {
            box.hidden = true;
            action.run();
        };
        box.append(button);
    }
    box.hidden = false;
    clearTimeout(Number(box.dataset.timer));
    if (!action) box.dataset.timer = String(setTimeout(() => (box.hidden = true), link ? 15_000 : 6_000));
}

function setStatus(text: string, isDirty = dirty, busy = false) {
    dirty = isDirty;
    $('status').textContent = text;
    $('status').classList.toggle('busy', busy);
    $('status').classList.toggle('dirty', isDirty);
}

const errorText = (error: unknown) => t('error', { message: error instanceof Error ? error.message : String(error) });
const repoName = (target: Target) => `${target.owner}/${target.repo}`;
const query = (target: Target, branch?: string, path = target.path) =>
    `?${new URLSearchParams({ repo: repoName(target), ...(branch ? { branch } : {}), ...(path ? { path } : {}) })}`;

function landing(message = '', action?: { label: string; run(): void }, busy = false) {
    $('landing').hidden = false;
    $('message').replaceChildren(message);
    $('message').classList.toggle('busy', busy);
    if (action) {
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: action.label, className: 'github' });
        button.onclick = action.run;
        $('message').append(' ', button);
    }
}

async function signInAndRetry(target: Target) {
    const popup = openPopup(); // inside the click handler
    try {
        await login(popup, config);
    } finally {
        popup.close();
    }
    await open(target);
}

async function open(target: Target) {
    landing(t('opening', { repo: repoName(target) }), undefined, true);
    ($('repo-input') as HTMLInputElement).value = repoName(target);
    const token = await currentToken();
    try {
        project = await loadProject(createApi(token), target, !!token);
    } catch (error) {
        const anonymous = !token && error instanceof GitHubError && (error.status === 404 || error.status === 403 || error.status === 401);
        if (anonymous && config.clientId) {
            landing(error.status === 404 ? t('notFound') : t('rateLimited'), { label: t('signIn'), run: () => signInAndRetry(target).catch((e) => landing(errorText(e))) });
        } else {
            landing(errorText(error));
        }
        return;
    }
    if (!project.files.has('content.xml')) {
        landing(t('noProject', { repo: repoName(target), path: target.path ? `/${target.path}` : '' }));
        if (project.candidates.length) {
            $('candidates').replaceChildren(
                t('pickFolder'),
                ...project.candidates.map((path) => {
                    const item = document.createElement('li');
                    item.append(Object.assign(document.createElement('a'), { href: query(target, project?.branch, path), textContent: path || '/' }));
                    return item;
                }),
            );
        }
        return;
    }

    const { repo } = target;
    $('landing').hidden = true;
    $('bar').hidden = false;
    $('editor').hidden = false;
    showRepoLink();
    document.title = `${repo} · eXeLearning`;
    setStatus(t('loadingEditor'), false, true);
    editor = new EditorFrame($('editor'), config.editorOrigin);
    editor.onDirty = () => setStatus(t('unsaved'), true);
    editor.onSaveShortcut = () => $('save').click();
    try {
        await editor.open(buildElpx(project.files), `${repo}.elpx`);
        setStatus('', false);
        $<HTMLButtonElement>('save').disabled = false;
    } catch (error) {
        setStatus(errorText(error), false);
    }
}

/** Repository · branch · folder in the bar (the branch changes after saving as a pull request). */
function showRepoLink() {
    if (!project) return;
    const { owner, repo, path } = project.target;
    Object.assign($<HTMLAnchorElement>('repo-link'), {
        href: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(project.branch)}/${path}`,
        textContent: `${owner}/${repo} · ${project.branch}${path ? ` · ${path}` : ''}`,
    });
}

/** Collect commit options; resolves in the click handler so a GitHub popup can still be opened. */
function askSave(files: string[], removed: string[], needPopup: () => boolean): Promise<{ message: string; pullRequest: boolean; deleteRemoved: boolean; popup?: Window } | undefined> {
    const dialog = $<HTMLDialogElement>('save-dialog');
    $('save-files').replaceChildren(...files.map((path) => Object.assign(document.createElement('li'), { textContent: path })));
    $('delete-row').hidden = removed.length === 0;
    $('delete-label').textContent = t('deleteRemoved', { n: removed.length });
    $<HTMLInputElement>('delete-removed').checked = false;
    const branch = project?.branch ?? '';
    const locked = !!project?.protectedBranch;
    $('branch-label').textContent = locked ? t('protectedNote', { branch }) : t('toBranch', { branch });
    $<HTMLInputElement>('to-branch').disabled = locked;
    $<HTMLInputElement>(locked ? 'to-pr' : 'to-branch').checked = true;
    $<HTMLInputElement>('commit-message').value = t('defaultMessage');
    dialog.showModal();
    return new Promise((resolve) => {
        $('confirm-save').onclick = (event) => {
            const message = $<HTMLInputElement>('commit-message').value.trim();
            if (!message) return;
            event.preventDefault();
            let popup: Window | undefined;
            try {
                if (needPopup()) popup = openPopup();
            } catch (error) {
                toast(errorText(error));
            }
            dialog.close();
            resolve({ message, pullRequest: $<HTMLInputElement>('to-pr').checked, deleteRemoved: $<HTMLInputElement>('delete-removed').checked, popup });
        };
        dialog.onclose = () => resolve(undefined);
    });
}

async function save() {
    if (!project || !editor || saving) return;
    if (!config.clientId) return toast(t('notConfigured'));
    saving = true;
    const previous = $('status').textContent ?? '';
    let popup: Window | undefined;
    try {
        setStatus(t('saving'), dirty, true);
        const { bytes, requestId } = await editor.exportElpx();
        const exported: Files = readElpx(bytes);
        exported.set('content.xml', dropScreenshotProperty(exported.get('content.xml') as Uint8Array));
        const plan = planSave(exported, project.files, project.files);
        if (!plan.write.length && !plan.removed.length) {
            editor.markClean(requestId);
            setStatus('', false);
            return toast(t('noChanges'));
        }

        const { owner, repo } = project.target;
        let token = await currentToken();
        let access = token ? await appCanAccess(createApi(token), owner, project.repoId).catch(() => false) : undefined;
        setStatus(previous);
        const options = await askSave([...plan.write, ...plan.removed.map((p) => `− ${p}`)], plan.removed, () => !hasUsableToken() || access === false);
        if (!options) return;
        popup = options.popup;
        setStatus(t('saving'), dirty, true);

        if (!token) {
            if (!popup) throw new Error(t('loginNeeded'));
            token = await login(popup, config, project.repoId);
        }
        const api = createApi(token);
        if (access !== true) access = await appCanAccess(api, owner, project.repoId);
        if (!access) {
            if (!popup) throw new Error(t('installNeeded', { repo: `${owner}/${repo}` }));
            toast(t('installNeeded', { repo: `${owner}/${repo}` }));
            await install(popup, config, project.ownerId);
            if (!(await appCanAccess(api, owner, project.repoId))) throw new Error(t('noAccess', { repo: `${owner}/${repo}` }));
        }
        popup?.close();

        const result = await saveProject(api, project, plan, exported, options);
        for (const path of plan.write) project.files.set(path, exported.get(path) as Uint8Array);
        for (const path of plan.removed) project.files.delete(path); // asked once; kept files are no longer tracked
        Object.assign(project, { commitSha: result.commitSha, treeSha: result.treeSha, branch: result.branch, protectedBranch: false });
        showRepoLink();
        editor.markClean(requestId);
        setStatus(t('saved'), false);
        toast(result.kind === 'commit' ? t('committed', { branch: result.branch }) : t('pullRequest'), { href: result.url, label: t('view') });
    } catch (error) {
        setStatus(t('unsaved'), true);
        const status = error instanceof GitHubError ? error.status : 0;
        toast(status === 403 || status === 404 ? t('noAccess', { repo: repoName(project.target) }) : errorText(error));
    } finally {
        popup?.close();
        saving = false;
    }
}

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
};

async function signIn() {
    const popup = openPopup(); // inside the click handler
    try {
        await login(popup, config);
    } finally {
        popup.close();
    }
    await showRepos();
}

async function giveAccess() {
    const popup = openPopup();
    try {
        await install(popup, config);
    } finally {
        popup.close();
    }
    await showRepos();
}

const VIEW_KEY = 'exelearning-resources-view';

function setView(view: 'grid' | 'list') {
    $('repos').className = view;
    $('view-grid').setAttribute('aria-pressed', String(view === 'grid'));
    $('view-list').setAttribute('aria-pressed', String(view === 'list'));
    try {
        localStorage.setItem(VIEW_KEY, view);
    } catch {
        // storage unavailable: the choice lasts until reload
    }
}

const relative = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
function updatedAgo(iso: string): string {
    const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
    if (!iso || Number.isNaN(days)) return '';
    if (Math.abs(days) < 30) return relative.format(days, 'day');
    if (Math.abs(days) < 365) return relative.format(Math.round(days / 30), 'month');
    return relative.format(Math.round(days / 365), 'year');
}

/** One card per eXeLearning resource; its title and screenshot load afterwards. */
function resourceCard(api: Api, resource: Resource): HTMLLIElement {
    const { repo, path } = resource;
    const name = `${repo.owner}/${repo.repo}`;
    const title = element('span', { className: 'title', textContent: path ? path.split('/').pop() : repo.repo });
    const meta = element('span', { className: 'meta', textContent: [name, path || t('root'), updatedAgo(repo.pushedAt)].filter(Boolean).join(' · ') });
    meta.title = meta.textContent ?? '';
    if (repo.private) meta.append(' ', element('span', { className: 'badge', textContent: t('private') }));
    const thumb = element('div', { className: 'thumb' });
    const edit = element('a', { className: 'button edit', href: query({ owner: repo.owner, repo: repo.repo, path: '' }, undefined, path) }, t('edit'));
    const github = element('a', {
        href: `https://github.com/${name}/tree/${encodeURIComponent(repo.defaultBranch)}/${path}`,
        target: '_blank',
        rel: 'noopener',
        textContent: t('view'),
    });
    const card = element('li', { className: 'card' }, thumb, element('div', { className: 'info' }, element('div', { className: 'text' }, title, meta), element('div', { className: 'actions' }, edit, github)));

    void blobBytes(api, repo, resource.contentSha)
        .then((bytes) => {
            const found = readTitle(new TextDecoder().decode(bytes));
            if (found) title.textContent = found;
        })
        .catch(() => {});
    const noShot = () => {
        thumb.className = 'thumb empty';
        thumb.replaceChildren(element('img', { src: '/editor/exelearning.png', alt: '' }), element('span', { textContent: t('noScreenshot') }));
    };
    if (resource.screenshotSha) {
        void blobBytes(api, repo, resource.screenshotSha)
            .then((bytes) => thumb.replaceChildren(element('img', { className: 'shot', alt: '', src: URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'image/png' })) })))
            .catch(noShot);
    } else {
        noShot();
    }
    return card;
}

/** "Your eXeLearning resources": every resource in the repositories the app can reach. */
async function showRepos() {
    const token = await currentToken();
    const signedOut = !token && !!config.clientId;
    $('signin-card').hidden = !signedOut;
    $('divider').hidden = !signedOut;
    $('repos-box').hidden = !token;
    $('landing').classList.toggle('wide', !!token);
    // Signed in, the box becomes a small "another repository?" line below the resources.
    const form = $('open-form');
    form.classList.toggle('compact', !!token);
    $('repo-label').textContent = token ? t('otherRepo') : t('repoLabel');
    if (token) $('repos-box').insertBefore(form, $('repos-box').querySelector('.links'));
    else $('divider').after(form);
    if (!token) return;
    const api = createApi(token);
    const login = await api<{ login: string }>('/user').then((u) => u.login, () => '');
    let repos: RepoSummary[];
    try {
        repos = await listAccessibleRepos(api);
    } catch (error) {
        return landing(errorText(error));
    }
    const list = $('repos');
    const others: string[] = [];
    let resources = 0;
    let withResources = 0;
    let pending = repos.length;
    const searching = element('li', { className: 'searching' });
    const update = () => {
        const summary = t('summary', { n: resources, r: withResources });
        $('repos-summary').textContent = !repos.length ? t('noRepos') : login ? t('signedInAs', { summary, login }) : summary;
        searching.textContent = t('searchingMore', { n: pending });
        searching.classList.toggle('busy', pending > 0);
        if (!pending) searching.remove();
        $('other-repos').hidden = !others.length;
        $('other-summary').textContent = t('otherRepos', { n: others.length });
        $('other-list').replaceChildren(...others.map((name) => element('li', { textContent: name })));
    };
    list.replaceChildren(searching);
    others.length = 0;
    update();
    let next = 0;
    const worker = async () => {
        while (next < repos.length) {
            const repo = repos[next++];
            const found = await findProjects(api, repo).catch(() => []);
            pending--;
            if (found.length) {
                withResources++;
                resources += found.length;
                for (const resource of found) list.insertBefore(resourceCard(api, resource), searching);
            } else {
                others.push(`${repo.owner}/${repo.repo}`);
            }
            update();
        }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
}

async function showPagesDialog() {
    if (!project) return;
    const { owner, repo, path } = project.target;
    const template = await fetch('/templates/exelearning-pages.yml').then((r) => r.text());
    const workflow = pagesWorkflow(template, project.baseBranch, path);
    $<HTMLAnchorElement>('pages-workflow').href = `https://github.com/${owner}/${repo}/new/${encodeURIComponent(project.baseBranch)}?${new URLSearchParams({
        filename: '.github/workflows/exelearning-pages.yml',
        value: workflow,
    })}`;
    $<HTMLAnchorElement>('pages-settings').href = `https://github.com/${owner}/${repo}/settings/pages`;
    const site = repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${repo}/` : `https://${owner.toLowerCase()}.github.io/${repo}/`;
    $('pages-result').replaceChildren(t('pagesResult', { url: '' }), element('a', { href: site, target: '_blank', rel: 'noopener', textContent: site }));
    $<HTMLDialogElement>('pages-dialog').showModal();
}

async function download() {
    if (!project || !editor) return;
    const { bytes } = await editor.exportElpx();
    const link = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/zip' })),
        download: `${project.target.repo}.elpx`,
    });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

async function copyBadge() {
    if (!project) return;
    const url = `${location.origin}/${query(project.target, project.branch === 'main' ? undefined : project.branch)}`;
    const label = lang === 'es' ? 'Editar%20en' : 'Edit%20in';
    const alt = lang === 'es' ? 'Editar en eXeLearning' : 'Edit in eXeLearning';
    await navigator.clipboard.writeText(`[![${alt}](https://img.shields.io/badge/${label}-eXeLearning-26ddc7?labelColor=1f2937)](${url})`);
    toast(t('badgeCopied'));
}

async function main() {
    document.documentElement.lang = lang;
    const texts: Record<string, Parameters<typeof t>[0]> = {
        tagline: 'tagline', 'repo-label': 'repoLabel', 'open-button': 'open', 'save-label': 'save', download: 'download', badge: 'copyBadge',
        other: 'openOther', logout: 'logout', 'message-label': 'commitMessage', 'files-label': 'filesToSave',
        'pr-label': 'asPullRequest', 'cancel-save': 'cancel', 'confirm-save': 'save', 'signin-label': 'signIn', 'see-all': 'seeAll', 'see-all-hint': 'seeAllHint', 'or-open': 'orOpen', 'open-hint': 'publicHint', experimental: 'experimental', 'source-label': 'source', 'repos-title': 'yourRepos',
        'more-access': 'moreAccess', 'view-grid-label': 'gridView', 'view-list-label': 'listView', 'logout-landing': 'logout', pages: 'publishPages', 'pages-title': 'pagesTitle',
        'pages-intro': 'pagesIntro', 'pages-workflow': 'pagesWorkflow', 'pages-settings': 'pagesSettings', 'pages-close': 'close',
    };
    for (const [id, key] of Object.entries(texts)) $(id).textContent = t(key);

    $('save').onclick = () => void save();
    $('download').onclick = () => void download().catch((e) => toast(errorText(e)));
    $('badge').onclick = () => void copyBadge().catch((e) => toast(errorText(e)));
    $('other').onclick = () => {
        location.href = '/';
    };
    $('logout').onclick = () => {
        logout();
        toast(t('logout'));
    };
    $('view-grid').onclick = () => setView('grid');
    $('view-list').onclick = () => setView('list');
    try {
        if (localStorage.getItem(VIEW_KEY) === 'list') setView('list');
    } catch {
        // storage unavailable
    }
    $('pages').onclick = () => void showPagesDialog().catch((e) => toast(errorText(e)));
    $('pages-close').onclick = () => $<HTMLDialogElement>('pages-dialog').close();
    $('signin').onclick = () => void signIn().catch((e) => landing(errorText(e)));
    $('more-access').onclick = () => void giveAccess().catch((e) => landing(errorText(e)));
    $('logout-landing').onclick = () => {
        logout();
        void showRepos();
    };
    for (const button of document.querySelectorAll('.menu div button')) button.addEventListener('click', () => $('bar').querySelector('details')?.removeAttribute('open'));
    $('open-form').onsubmit = (event) => {
        event.preventDefault();
        const value = ($('repo-input') as HTMLInputElement).value.trim();
        const target = parseTarget(new URLSearchParams({ repo: value }));
        if (target) location.search = query(target, target.branch);
        else landing(t('notFound'));
    };
    window.addEventListener('beforeunload', (event) => {
        if (dirty) event.preventDefault();
    });

    config = await fetch('/api/github/config').then((r) => r.json());
    // Never run the app (and hold GitHub tokens) on the origin that renders project content.
    if (location.origin === config.editorOrigin) return location.replace(`${config.appOrigin}/${location.search}`);
    const target = parseTarget(new URLSearchParams(location.search));
    if (target) await open(target);
    else await showRepos();
}

main().catch((error) => landing(errorText(error)));
