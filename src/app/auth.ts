// GitHub App user login: popup + PKCE; the Worker (/api/github/token) holds the client secret.
// Tokens live in this page's sessionStorage only. The editor runs on another origin, so the
// project content it renders can never read them.
import type { Api } from './github.ts';

export interface AppConfig {
    clientId: string;
    appSlug: string;
    appOrigin: string;
    editorOrigin: string;
}

interface StoredToken {
    access: string;
    expiresAt: number;
    refresh?: string;
}

const KEY = 'exelearning-github-token';
const CALLBACK = `${location.origin}/auth/callback.html`;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

function store(data: { access_token: string; expires_in?: number; refresh_token?: string }): string {
    const token: StoredToken = {
        access: data.access_token,
        // Tokens without expiry (expiring tokens disabled) are kept for the session.
        expiresAt: data.expires_in ? Date.now() + (data.expires_in - 60) * 1000 : Number.MAX_SAFE_INTEGER,
        refresh: data.refresh_token,
    };
    sessionStorage.setItem(KEY, JSON.stringify(token));
    return token.access;
}

async function exchange(body: Record<string, unknown>): Promise<string> {
    const response = await fetch('/api/github/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error(data.error_description ?? data.error ?? 'GitHub login failed');
    return store(data);
}

/** A valid access token, refreshing it if needed, or undefined when the user must log in. */
export async function currentToken(): Promise<string | undefined> {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return undefined;
    const token = JSON.parse(raw) as StoredToken;
    if (Date.now() < token.expiresAt) return token.access;
    if (!token.refresh) return logout();
    return exchange({ refresh_token: token.refresh }).catch(() => logout());
}

/** Synchronous check, so a click handler knows whether it must open the login popup. */
export function hasUsableToken(): boolean {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return false;
    const token = JSON.parse(raw) as StoredToken;
    return Date.now() < token.expiresAt || !!token.refresh;
}

export function logout(): undefined {
    sessionStorage.removeItem(KEY);
    return undefined;
}

/** Open the popup synchronously inside a click handler, before any await, or it gets blocked. */
export function openPopup(): Window {
    const popup = window.open('', 'exelearning-github', 'popup,width=640,height=760');
    if (!popup) throw new Error('The browser blocked the GitHub window. Allow pop-ups for this site and try again.');
    return popup;
}

/** Wait for auth/callback.html (same origin) to report the GitHub redirect parameters. */
function waitForCallback(popup: Window): Promise<URLSearchParams> {
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (popup.closed) {
                cleanup();
                reject(new Error('The GitHub window was closed.'));
            }
        }, 500);
        const onMessage = (event: MessageEvent) => {
            if (event.origin !== location.origin || event.source !== popup || event.data?.type !== 'github-callback') return;
            cleanup();
            resolve(new URLSearchParams(event.data.search));
        };
        const cleanup = () => {
            clearInterval(timer);
            window.removeEventListener('message', onMessage);
        };
        window.addEventListener('message', onMessage);
    });
}

/** Log in with GitHub in popup; the token is limited to repositoryId when the app can access it. */
export async function login(popup: Window, config: AppConfig, repositoryId?: number): Promise<string> {
    const state = random();
    const verifier = random();
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    popup.location.href = `https://github.com/login/oauth/authorize?${new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: CALLBACK,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    })}`;
    const params = await waitForCallback(popup);
    if (params.get('state') !== state || !params.get('code')) throw new Error('GitHub login was cancelled or could not be verified.');
    return exchange({ code: params.get('code'), code_verifier: verifier, redirect_uri: CALLBACK, repository_id: repositoryId });
}

/** Ask the user to install the GitHub App on the repository owner's account (choosing repositories). */
export async function install(popup: Window, config: AppConfig, ownerId?: number): Promise<void> {
    popup.location.href = ownerId
        ? `https://github.com/apps/${config.appSlug}/installations/new/permissions?target_id=${ownerId}`
        : `https://github.com/apps/${config.appSlug}/installations/new`;
    await waitForCallback(popup);
}

/** Whether the GitHub App is installed with access to the repository. */
export async function appCanAccess(api: Api, owner: string, repositoryId: number): Promise<boolean> {
    const { installations } = await api<{ installations: { id: number; account: { login: string }; repository_selection: string }[] }>(
        '/user/installations?per_page=100',
    );
    for (const installation of installations) {
        if (installation.account.login.toLowerCase() !== owner.toLowerCase()) continue;
        if (installation.repository_selection === 'all') return true;
        for (let page = 1; page < 50; page++) {
            const { repositories } = await api<{ repositories: { id: number }[] }>(
                `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
            );
            if (repositories.some((r) => r.id === repositoryId)) return true;
            if (repositories.length < 100) break;
        }
    }
    return false;
}
