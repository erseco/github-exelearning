# AGENTS.md

Conventions for agents working on **github-exelearning** (https://github.exelearning.dev):
a static app plus one Cloudflare Worker. It opens an eXeLearning project stored unpacked in
a GitHub repository in the official static editor, and saves it back as a commit or a pull
request. This is an experiment: it decides whether this stays separate or moves into
eXeLearning (see `RESEARCH.md`, *Path to eXeLearning core*).

## Ground rules

- **The editor is the official eXeLearning static build, unmodified.**
  - `scripts/fetch-editor.mjs` downloads a pinned release (SHA-256 checked) into `editor/`.
  - `scripts/build.mjs` only adds `editor/embed.html` (embedding config + `src/editor/adapter.ts`).
  - Talk to it through the postMessage embedding protocol (eXeLearning
    `doc/development/embedding.md`). Do not patch editor files.
  - Workarounds for editor gaps go in the adapter, with a comment naming the eXeLearning
    issue or PR (exelearning#2530, #2531).
- **Two origins, by design.**
  - The app (`APP_ORIGIN`, `github.exelearning.dev`) holds the GitHub token.
  - The editor (`EDITOR_ORIGIN`, `github-editor.exelearning.dev`) renders untrusted project
    content.
  - Never load the editor on the app origin, never send tokens to the editor, and keep the
    CSPs (app CSP in `worker/index.ts`, editor CSP in `_headers` from `scripts/build.mjs`).
- **The only server code is `worker/index.ts`.** It handles the GitHub App token
  exchange/refresh, the public config and the headers. No databases, no stored tokens, no
  other endpoints without a strong reason.
  - The client secret is a Worker secret (`wrangler secret put GITHUB_CLIENT_SECRET`) and
    never goes in files.
  - `GITHUB_CLIENT_ID`/`GITHUB_APP_SLUG` in `wrangler.jsonc` are public.
- **A save writes the project source**: `content.xml`, `content/resources/**`,
  `screenshot.png` (`src/sync.ts`). Published files (`index.html`, `html/`, `libs/`…) only
  when the user ticks *Also save the exported website*, and only those whose git blob SHA
  changed. Never `theme/` or anything else in the user's repository. Deleting files needs
  explicit consent.
- **Untrusted input:** ZIPs from the editor go through `readElpx` (path and size limits);
  paths through `isSafePath`.
- Use plain browser APIs and minimal dependencies (runtime: `fflate` only). No frameworks.
- English for code, comments and docs. UI strings live in `src/app/i18n.ts`, in English and
  Spanish.

## Layout

| Path | Role |
|---|---|
| `src/app/` | The page: `main.ts` (UI flow), `github.ts` (REST API), `auth.ts` (login popup, PKCE, installations), `editor.ts` (iframe + protocol), `i18n.ts` |
| `src/editor/adapter.ts` | Runs inside the editor: dirty events, mark clean, Ctrl/Cmd+S |
| `src/elpx.ts`, `src/sync.ts` | Pure logic: ELPX packaging and the save plan (no DOM, unit-tested in Node) |
| `worker/index.ts` | Cloudflare Worker |
| `public/` | Static pages, CSS, `templates/exelearning-pages.yml` (Pages workflow offered to users) |
| `scripts/` | `fetch-editor.mjs`, `build.mjs`, `register-github-app.html` (GitHub App manifest) |
| `test/unit/` | `node --test` with TypeScript type stripping (import with `.ts` extensions; no parameter properties or enums) |
| `test/e2e.mjs` | `wrangler dev` + Chromium + GitHub faked from `test/fixture` |

## Commands

```sh
npm ci
npm run fetch-editor   # editor/ (needed by build, dev, e2e)
npm run fixture        # test/fixture: disposable clone of exelearning-style-book
npm run lint           # Biome (lint only, no formatter)
npm run typecheck
npm test               # unit
npm run test:e2e       # end to end (needs fetch-editor + fixture; HEADED=1 to watch)
npm run dev            # http://localhost:8787 (app) + http://127.0.0.1:8787 (editor)
npm run deploy         # production: only when asked
```

Before finishing a change, run `npm run lint`, `npm run typecheck` and `npm test`. Also run
`npm run test:e2e` when touching the UI, the editor bridge, the Worker or the build. CI
(`.github/workflows/ci.yml`) runs the same commands.

## Notes

- `wrangler dev` rewrites `request.url` to the production host, so host checks in the Worker
  only act in production. The page also refuses to run on the editor origin.
- Static assets drop `.html` (307 to the path without it) and keep the query string.
- Never commit `app.json` (GitHub App credentials), `editor/`, `dist/` or `test/fixture/`.
- Do not deploy, push, or touch real GitHub repositories, the GitHub App or Cloudflare
  settings unless asked.
- No AI attribution in commits, PRs or code.
