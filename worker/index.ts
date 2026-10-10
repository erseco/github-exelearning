// Cloudflare Worker for github.exelearning.dev (app) and github-editor.exelearning.dev (editor).
// Static files come from ./dist; the only server-side job is the GitHub App token exchange,
// because github.com/login/oauth/access_token needs the client secret and has no CORS.

interface Env {
    ASSETS: { fetch(request: Request): Promise<Response> };
    APP_ORIGIN: string;
    EDITOR_ORIGIN: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_APP_SLUG?: string;
    GITHUB_CLIENT_SECRET?: string;
}

const TOKEN_FIELDS = ['access_token', 'expires_in', 'refresh_token', 'refresh_token_expires_in', 'token_type', 'error', 'error_description'];

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function appHeaders(response: Response, env: Env): Response {
    const headers = new Headers(response.headers);
    headers.set(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "connect-src 'self' https://api.github.com https://raw.githubusercontent.com",
            `frame-src ${env.EDITOR_ORIGIN}`,
            "frame-ancestors 'none'",
            "form-action 'none'",
            "base-uri 'none'",
            "object-src 'none'",
        ].join('; '),
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function exchangeToken(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (request.headers.get('Origin') !== env.APP_ORIGIN) return json({ error: 'forbidden' }, 403);
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: 'not_configured' }, 501);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const params = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET });
    if (typeof body.code === 'string') {
        params.set('code', body.code);
        if (typeof body.code_verifier === 'string') params.set('code_verifier', body.code_verifier);
        if (typeof body.redirect_uri === 'string' && body.redirect_uri.startsWith(`${env.APP_ORIGIN}/`)) params.set('redirect_uri', body.redirect_uri);
        // Limits the token to the repository being edited (ignored if the app cannot access it).
        if (Number.isSafeInteger(body.repository_id)) params.set('repository_id', String(body.repository_id));
    } else if (typeof body.refresh_token === 'string') {
        params.set('grant_type', 'refresh_token');
        params.set('refresh_token', body.refresh_token);
    } else {
        return json({ error: 'invalid_request' }, 400);
    }
    const response = await fetchImpl('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'github-exelearning' },
        body: params,
    });
    const data = (await response.json().catch(() => ({ error: 'bad_gateway' }))) as Record<string, unknown>;
    const result = Object.fromEntries(TOKEN_FIELDS.filter((key) => key in data).map((key) => [key, data[key]]));
    return json(result, response.ok && !data.error ? 200 : 400);
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        // The editor host only serves /editor/*; the app (and its GitHub tokens) live on APP_ORIGIN.
        if (url.origin === env.EDITOR_ORIGIN) return Response.redirect(`${env.APP_ORIGIN}${url.pathname}${url.search}`, 302);
        if (url.pathname === '/api/github/config') {
            return json({ clientId: env.GITHUB_CLIENT_ID ?? '', appSlug: env.GITHUB_APP_SLUG ?? '', appOrigin: env.APP_ORIGIN, editorOrigin: env.EDITOR_ORIGIN });
        }
        if (url.pathname === '/api/github/token') return exchangeToken(request, env);
        return appHeaders(await env.ASSETS.fetch(request), env);
    },
};
