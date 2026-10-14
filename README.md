# eXeLearning · GitHub

**https://github.exelearning.dev** opens an eXeLearning resource stored in a GitHub repository
(an `.elpx` unpacked in the repository) in the official eXeLearning editor and saves the changes
back to the repository as a commit, or as a pull request. It is a static site plus one
small Cloudflare Worker; there is no other server.

> **Experiment.** It tests the whole cycle (open, edit, save, publish) to decide whether this
> stays a separate app or moves into eXeLearning itself. See *Path to eXeLearning core* in
> [RESEARCH.md](RESEARCH.md).

## For teachers

Add this badge to the README of a repository that contains an eXeLearning resource
(replace `owner/repository`):

```markdown
[![Edit in eXeLearning](https://img.shields.io/badge/Edit%20in-eXeLearning-26ddc7?labelColor=1f2937)](https://github.exelearning.dev/?repo=owner/repository)
```

Optional parameters: `&branch=name` and `&path=folder` (when the resource is not at the root).
Full GitHub URLs work too: `?repo=https://github.com/owner/repository/tree/main/folder`.
Once a resource is open, *⋯ → Copy README badge* gives you the exact snippet.

1. **Open** a resource in one of three ways:
   - click the badge;
   - go to https://github.exelearning.dev and type the repository (or paste its URL);
   - on that page, *Sign in with GitHub*: **Your repositories** lists the repositories the
     *eXeLearning* app can access, those with resources first, with one link per resource
     folder. *Give eXeLearning access to more repositories* opens GitHub's own repository
     picker.

   Public repositories open without signing in.
2. **Edit** in the editor as usual. The bar on top shows *Unsaved changes*.
3. **Save to GitHub** (button or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>S</kbd>): the dialog is
   GitHub's own. Write a commit message and pick *Commit directly to the `main` branch* or
   *Create a branch for this change and start a pull request*. The first time, a GitHub window
   asks you to sign in and to give the app access to that repository. Choose *Only select
   repositories* to grant access to that repository only.
4. If the branch is protected, or someone else changed the same files meanwhile, it opens a
   pull request instead. After a pull request, later saves go to its branch (shown in the bar).
5. **Publish** (once per repository): *⋯ → Publish on GitHub Pages* gives two links:
   - a GitHub page with the publishing workflow already written (press *Commit changes*);
   - the Pages settings (*Source: GitHub Actions*).

   From then on, every save rebuilds the website with the eXeLearning CLI (official Docker
   image) and publishes it at `https://owner.github.io/repository/`. The workflow is
   [`public/templates/exelearning-pages.yml`](public/templates/exelearning-pages.yml); adding
   it needs no extra permission for the app.

**What a save writes:** `content.xml`, new or changed files in `content/resources/`, and
`screenshot.png`, in a single commit. It never touches `theme/` or files outside the export.
Files you delete in eXeLearning's file manager are deleted only if you tick that option. The
website is normally rebuilt by the Pages workflow (step 5), so the repository keeps only the
source. *Also save the exported website* adds the changed published files (`index.html`,
`html/`, `libs/`…) to the commit; it is ticked by default when the folder already has an
`index.html`.

Without write access to the repository (for example, a student opening a teacher's resource),
use *⋯ → Download .elpx*.

## How it works

```
github.exelearning.dev            app: open/save, GitHub login, holds the token
  └─ iframe github-editor.exelearning.dev/editor/embed.html
       official eXeLearning static editor (v4.0.5) + small adapter,
       driven only through its postMessage embedding protocol
Cloudflare Worker                 static files + /api/github/token (client secret)
GitHub REST API (CORS)            read the tree/files, write blobs → tree → commit → ref / pull request
```

- **Two origins.** The editor renders the project's content (iDevice scripts, the style's
  JavaScript). It runs on its own origin, so that content can never read the GitHub token,
  which lives only in the app's `sessionStorage`.
- **GitHub App, not OAuth App.** The user picks the repositories the app may write to. The
  token is requested with `repository_id` (limited to the repository being edited), uses
  PKCE, and expires after 8 hours (refreshed through the Worker).
- **The only server-side code** is the token exchange: GitHub's token endpoint needs the
  client secret and does not allow browser (CORS) requests. Everything else goes from the
  browser to `api.github.com`.
- **Reading.** Public repositories are read anonymously: three API calls plus
  `raw.githubusercontent.com`. Once signed in, files come from the authenticated API, which
  also works for private repositories.
- **Saving** reuses the editor's documented `REQUEST_EXPORT` (`elpx`). It unzips the export
  with path and size checks and drops the duplicated `pp_screenshot`
  ([exelearning#2531](https://github.com/exelearning/exelearning/pull/2531)). Then it
  compares with the files at the opened commit and writes only the changed source files.

Details, measurements and the alternatives that were evaluated (a github.dev extension,
online.exelearning.net) are in [RESEARCH.md](RESEARCH.md).

## Develop

Requires Node 20+ and [wrangler](https://developers.cloudflare.com/workers/wrangler/).

```sh
npm install
npm run fetch-editor   # official static editor v4.0.5 → editor/ (SHA-256 checked)
npm run fixture        # disposable clone of exelearning-style-book → test/fixture/ (tests only)
npm run dev            # http://localhost:8787 (app) + http://127.0.0.1:8787 (editor)
```

`npm run fetch-editor -- <dir|zip>` installs a local static build instead (for example an
eXeLearning branch built with `bun run build:static`).

Checks (also run by CI, `.github/workflows/ci.yml`; agent conventions in [AGENTS.md](AGENTS.md)):

```sh
npm run lint       # Biome
npm run typecheck
npm test           # unit: ELPX packaging, path safety, zip limits, save plan, GitHub commit/PR logic, token endpoint
npm run test:e2e   # real Worker (wrangler dev) + real editor in Chromium, GitHub faked from test/fixture
```

The E2E opens `?repo=teacher/libro`, checks the Book style and the images, edits a text
iDevice, presses Ctrl/Cmd+S, signs in and checks the commit sent to GitHub: one blob
(`content.xml`), base tree, parent, fast-forward. Screenshots go to `dist/e2e-*.png`
(`HEADED=1` shows the browser).

## Deploy

```sh
npm run deploy     # build + wrangler deploy (Worker, assets, both custom domains)
```

One-time GitHub App setup:

1. Open `scripts/register-github-app.html` in a browser signed in to GitHub and submit it.
   It registers the app from a manifest; the organization defaults to `exelearning`.
2. GitHub redirects to `https://github.exelearning.dev/setup.html` with a one-time code. Then:
   ```sh
   gh api -X POST /app-manifests/CODE/conversions > app.json   # keep it out of the repository
   ```
3. Put `client_id` and `slug` in `wrangler.jsonc` (`GITHUB_CLIENT_ID`, `GITHUB_APP_SLUG`), set
   the secret, deploy, and delete `app.json`:
   ```sh
   jq -r .client_secret app.json | npx wrangler secret put GITHUB_CLIENT_SECRET
   npm run deploy
   ```

## Layout

| Path | Role |
|---|---|
| `src/app/main.ts` | page: open from `?repo=`, editor bar, save dialog, badge |
| `src/app/github.ts` | GitHub API: target parsing, load project files, commit / pull request |
| `src/app/auth.ts`, `auth-callback.ts` | GitHub App login popup (PKCE), token storage and refresh, installation check |
| `src/app/editor.ts` | cross-origin editor iframe, embedding protocol |
| `src/editor/adapter.ts` | inside the editor: dirty events, mark clean after a save, Ctrl/Cmd+S |
| `src/elpx.ts`, `src/sync.ts` | ELPX packaging and the "what to save" plan (shared, unit-tested) |
| `worker/index.ts` | Cloudflare Worker: token exchange, config, app headers, editor-host redirect |
| `scripts/` | editor download, build (generates `editor/embed.html` and `_headers`), app registration page |

## Known limitations

- **No write access:** without write access to the repository, saving is not possible. A
  fork plus pull request flow is not implemented yet; use *Download .elpx*.
- **Published HTML committed to the repository** is rewritten only with *Also save the
  exported website*, and pages removed from the resource leave their old `html/` file behind.
- **Style prompt:** the editor asks to install a resource's custom style in every session.
  Accepting marks the resource as modified, and the first save normalizes `content.xml`
  (asset paths, version and date properties).
- **Anonymous rate limit:** GitHub allows 60 API requests per hour per IP address, and each
  opening uses 3. Signing in raises the limit.
- **Repository contents:** Git LFS files and repositories whose tree is too large for one API
  call are not supported.
- **Cloudflare bot detection:** the zone's JS detection script is blocked by the app's CSP.
  Harmless: it only disables that detection on this page.
