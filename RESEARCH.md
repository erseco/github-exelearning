# Research: editing eXeLearning resources stored on GitHub

Date: 2026-10-10. eXeLearning static editor **v4.0.5** (latest release) and `main` @ `319b5d2`.

## Decision

The goal: a teacher clicks a badge in their repository's README, edits the resource in the
eXeLearning editor and saves it back to the same repository. The users are external people,
not developers.

**Chosen: a static web app at `github.exelearning.dev` plus one Cloudflare Worker.** It embeds
the official static editor, logs in with a **GitHub App** and commits through the GitHub
REST API. This follows the same pattern as gdrive-exelearning, onedrive-exelearning and
nextcloud-exelearning: the editor stays unmodified, and the integration lives outside it.

| Option | Verdict |
|---|---|
| VS Code web extension in github.dev | Built and tested first (see [A](#a-github-dev-extension-evaluated-and-replaced)). It needs no server or login, but it requires installing an extension and VS Code's interface always surrounds the editor. Not suitable for teachers. |
| GitHub support inside eXeLearning (`online.exelearning.dev`) | Possible, but the login, the app secret and deployment-specific settings do not belong in the core editor. A separate project can be released and changed on its own. |
| **Separate web app + GitHub App** | Selected. Full-screen editor, an "Edit" badge, saving with one click. The only server piece is the token exchange. |
| OAuth App instead of GitHub App | To write, an OAuth App needs `public_repo` (every public repository of the user) or `repo` (every private one). A GitHub App lets the user pick repositories, its tokens can be limited to one repository (`repository_id`) and they expire. GitHub recommends GitHub Apps. |

## How other editors open from and save to GitHub

Reference points for the repository picker and the save step (from public knowledge of these
products, not re-checked here):

| App | Choosing the repository | Saving |
|---|---|---|
| Google Colab | One box for a URL or a user/organization, then repository and branch dropdowns | "Save a copy in GitHub": repository, branch, path and message in one form |
| draw.io | After login: organization → repository → branch → folder | Asks for a commit message; detects concurrent changes |
| GitHub web editor | — | Message plus *Commit directly to `main`* / *Create a branch and start a pull request* |
| Pages CMS | GitHub App; only the repositories where it is installed, plus a link to add more | Direct commits |
| Sveltia / Decap CMS | Per-repository configuration; OAuth through a small proxy (Sveltia: a Cloudflare Worker) | Direct commit, or branch plus pull request |
| StackBlitz | The URL itself: `/github/owner/repo` | Commit or pull request from the editor |
| MakeCode (education) | Create or link a repository from the editor | "Commit & push" with a summary of changes |

What this app takes from them:
- The URL (badge, `?repo=`) and a single box that accepts any form.
- After login, the GitHub App's installation acts as the repository picker (Pages CMS).
- GitHub's own save dialog.
- Publishing as a separate, one-time setup: a workflow, as an alternative to committing the
  generated HTML.

The earlier attempt in eXeLearning 3.x
([exelearning#337](https://github.com/exelearning/exelearning/pull/337), closed) published
exports to GitHub Pages, Netlify and Cloudflare Pages. It ran from the PHP server with an
OAuth App (`public_repo`), stored encrypted tokens in the database and offered a device flow
for desktop. This app keeps that idea of publishing, but does it with a workflow in the
teacher's own repository: no server-side tokens, no extra permission.

## Path to eXeLearning core

The same cycle could live in the editor's File menu, in the hidden entries revealed with Alt,
next to "Open from folder" / "Save to folder" (`navbarFile.js`, `ProjectFolderStorage.js`):
*Open from URL*, *Open from GitHub* and *Save to GitHub*. The Save button would become
*Save to GitHub* when the project came from GitHub.
- **Static/online build:** opening works without login. Saving is enabled only when a token
  endpoint (a Worker like this one) is configured.
- **Desktop app:** GitHub's device flow needs no client secret and no CORS, so no server at all.
- **Collaborative server ("cloud") mode:** excluded. Projects live on the server and are edited
  by several people at once.

The main open question is security: inside the editor, the token would share an origin with
the project content it renders. This app avoids that with two origins. In the core, the
mitigation would be a token limited to the repository (`repository_id`), kept in memory and
expiring.

The code to reuse: `src/app/github.ts` (read/commit/pull request, repository list and
detection), `src/elpx.ts`, `src/sync.ts` and the Pages workflow template.

## Verified facts

| Topic | Finding |
|---|---|
| GitHub OAuth endpoints | `github.com/login/oauth/access_token` and `/login/device/code` answer `OPTIONS` with 404 and no CORS headers (checked with `curl`). A browser cannot exchange a code, so a server-side exchange is required, and it holds the client secret. |
| GitHub REST API | `api.github.com` answers preflights with `access-control-allow-origin: *` for `GET/POST/PATCH/PUT/DELETE`. The whole read/commit/PR flow runs in the browser. |
| Raw files | `raw.githubusercontent.com` sends `access-control-allow-origin: *`. Public files are read without spending the anonymous API limit (60 requests/hour per IP), so opening costs 3 API calls. |
| GitHub App user tokens | The web flow supports PKCE (`code_challenge` S256), `repository_id` (limits the token to one repository; the login fails with "Your app doesn't have permission for the given target" if the app is not installed there) and expiring tokens with refresh. A user token only works on repositories where the app is installed **and** the user has access. Source: GitHub docs (Context7 `/github/docs`). |
| App registration | The manifest flow (`POST /settings/apps/new` with a JSON manifest, then `POST /app-manifests/{code}/conversions`) creates the app with fixed permissions: Contents write, Pull requests write, Metadata read; no webhooks. |
| Cloudflare | The `exelearning.dev` zone is in the account. A Worker with static assets and `custom_domain` routes serves both hostnames. `run_worker_first: ["/*", "!/editor/*"]` keeps the ~3,000 editor files from invoking the Worker. `wrangler dev` rewrites `request.url` to the route host, so host checks are also enforced in the page. By default the assets drop `.html` (307 to `/editor/embed`), and the query string is kept. |
| Cloudflare bot detection | The zone injects an inline JS detection script into HTML. The app's CSP (`script-src 'self'`) blocks it, which is harmless. |

## Architecture

```
github.exelearning.dev (Worker: run first)            github-editor.exelearning.dev (static, no Worker)
├─ index.html + app.js   open / save / login           └─ /editor/embed.html = official index.html
├─ /auth/callback.html   login popup landing                + __EXE_EMBEDDING_CONFIG__ (basePath /editor,
├─ /api/github/config    client id, app slug, origins         trusted origin = the app, hideUI)
└─ /api/github/token     code/refresh → token (secret)      + embed-adapter.js
```

**Open** (`?repo=owner/name[&branch=][&path=]`, `?gh=`, or a GitHub URL):
1. Read the repository info, then the branch (head commit, tree, `protected`), then the tree.
   Download only what the importer reads:
   - `content.xml`
   - `screenshot.png`
   - `content/resources/**`
   - `custom/**`
   - `theme/**`

   Hidden files and symlinks are skipped. If the folder has no `content.xml`, the app lists
   the folders that do.
2. Pack those files as an `.elpx` in memory with fflate (`buildElpx`).
3. Send it with `OPEN_FILE` once `EXELEARNING_READY` arrives.

**Save** (button or Ctrl/Cmd+S forwarded by the adapter):
1. Export with `REQUEST_EXPORT {format: "elpx"}`, unzip safely (`readElpx`) and drop `pp_screenshot`.
2. Plan the write with `planSave`, comparing against the opened files (see [C](#c-round-trip-measurements)).
3. In the dialog, the user confirms the commit message, the PR option and whether to delete removed files.
4. If needed, sign in in a popup opened inside the click, and install the app in the same popup.
5. Create blobs, a tree on `base_tree`, a commit with the opened commit as parent, then `PATCH` the ref with `force: false`.
   - If the branch moved and none of our files changed there, rebuild the commit on the new head.
   - If the same files changed, or the branch is protected, or the user asked for it: push an `exelearning/edit-<time>` branch and open a pull request.
6. After success, ask the editor to mark itself clean, only if no change happened during the save.

## Security

- **Untrusted content:** project content (iDevice scripts, style JavaScript) runs only on the
  editor origin. The token lives in the app origin's `sessionStorage`. The app refuses to run
  on the editor origin (checked by the Worker in production and by the page everywhere), and
  the editor host redirects every non-`/editor/` path to the app.
- **Editor CSP** (`_headers`, `/editor/*`):
  - `frame-ancestors` lists only the app;
  - `connect-src 'self' data: blob:`, so content cannot send data out with `fetch`/XHR;
  - scripts are limited to the editor's own files (`'unsafe-inline'` and `'unsafe-eval'` are needed by the editor).
- **App CSP** (set by the Worker):
  - `script-src 'self'`;
  - `connect-src` limited to itself, `api.github.com` and `raw.githubusercontent.com`;
  - `frame-src` limited to the editor origin;
  - `frame-ancestors 'none'`.
- **Messages:**
  - The app accepts editor messages only from the editor frame and origin.
  - The adapter only talks to an origin listed in the baked `trustedOrigins`.
  - Exports are matched to random `requestId`s.
- **Tokens:**
  - PKCE plus a random `state` checked on return.
  - The Worker accepts only `POST` with `Origin` equal to the app. It forwards a
    `redirect_uri` only if it points to the app, and returns only token fields, with
    `Cache-Control: no-store`.
- **ZIP from the editor:**
  - Path traversal is rejected.
  - Limits: 20,000 entries, 256 MB per entry and 768 MB in total.
  - fflate inflates into a buffer of the declared size, so a lying header is truncated rather than expanded (unit-tested).
- **Writes:** only `plan.write` paths (source files), joined under the project folder.
  `theme/` and published files are never written; deletions only on request.
- **Supply chain:** the editor release is pinned and SHA-256 verified (`scripts/fetch-editor.mjs`).

## A. github.dev extension (evaluated and replaced)

The first prototype was a VS Code web extension: a custom editor on `content.xml` that ran
the same editor in a webview and wrote through `vscode.workspace.fs`. It worked end to end in
VS Code for the Web (`@vscode/test-web`). Findings worth keeping:

- **Webview resources:** VS Code's webview service worker resolves the webview from the
  client URL's `?id=`. A nested `srcdoc`/`about:blank` frame cannot load extension resources.
  It worked by loading the sibling `fake.html?id=…` and writing the editor with
  `document.write` on `DOMContentLoaded` + `setTimeout`. Writing after `load` means the load
  event never fires again, and the editor starts from `window.onload`.
- **`window.parent` override:** VS Code sets `window.parent = window` inside the webview
  document, so the editor needs a nested frame for its `EmbeddingBridge` to start.
- **Inherited CSP:** a document written with `document.write` inherits the writer's CSP in
  Chromium.
- **Service worker hazard:** outside an installed PWA, the static editor's `index.html`
  unregisters every service worker whose URL contains `service-worker.js`. Inside a webview
  that would be VS Code's own worker.
- **Auto-save:** `files.autoSave` defaults to `afterDelay` on the web, so saves must be
  cheap and idempotent.
- **Why it was replaced:** it needs the extension installed, and VS Code's interface stays
  around the editor. Zen mode still shows the title bar on the web unless two global
  settings change. Fine for developers, not for teachers.

## B. eXeLearning embedding (applies to any host)

- **Configuration:** the static build runs unmodified with `window.__EXE_EMBEDDING_CONFIG__`
  injected first. `basePath` must point to the editor folder: preview service worker,
  `/viewer/` and data paths derive from it.
- **Lifecycle:** `EXELEARNING_READY` → `OPEN_FILE` → `OPEN_FILE_SUCCESS`. `DOCUMENT_LOADED`
  fires only once, for the initial empty project.
- **`REQUEST_SAVE` always fails** in v4.0.5 and `main`: `exportToElpxBlob` and
  `_yjsBridge.exporter` do not exist, so the answer is `REQUEST_SAVE_ERROR: Export not
  available`. The documented `REQUEST_EXPORT {format: "elpx"}` works and is what this app
  uses. Fix: [exelearning#2530](https://github.com/exelearning/exelearning/pull/2530).
- **`PROJECT_DIRTY`/`PROJECT_SAVED` are never emitted**: `notifyDirty`/`notifySaved` have no
  callers. The adapter relays the document manager's `saveStatus` instead. Fix: #2530.
- **Screenshot duplicated in `content.xml`:** every export writes the screenshot into
  `content.xml` as a base64 `pp_screenshot` (74 KB → 506 KB here), because the `screenshot`
  metadata key is missing from the XML exclusions. The app drops it before saving. Fix:
  [exelearning#2531](https://github.com/exelearning/exelearning/pull/2531).
- **What the importer reads:** `content.xml`, `content/resources/**`, legacy `custom/**`,
  `screenshot.png`, and `theme/**` when the style is not installed. Everything else is
  ignored.
- **Custom styles:** the editor asks *Import style?*. The answer is stored per editor origin.
  Accepting marks the project dirty even though the style does not change (upstream).
- **Other upstream observations:** the exported skip-link text follows the UI locale instead
  of the project language, and the preview's `stripUrl` throws in `blob:` mode. Neither
  matters here: published HTML is not written, and the preview uses its service worker on
  the editor origin.

## C. Round-trip measurements

Exporting exelearning-style-book from the editor without edits gives 148 files:

| Result | Files |
|---|---|
| Identical (132) | all resources, all 59 `theme/` files, `idevices/`, `screenshot.png`, `content.dtd`, `content/css`, `content/img` |
| Different (16) | `content.xml` (normalizations below, plus `pp_screenshot`), `index.html` and 10 `html/*.html`, `search_index.js`, three `libs/` files |
| Not in the package (preserved) | 14 files: `README.md`, `AGENTS.md`, `.github/`, `scripts/`, `edit-in-exelearning.js`… |

Details of the 16 differences:
- `content.xml`:
  - asset references become `{{context_path}}/content/resources/…`;
  - version properties are added;
  - `pp_modified` becomes epoch milliseconds;
  - plus the `pp_screenshot` copy described in B.
- HTML: the generator meta changes, the repository's `edit-in-exelearning.js` tag is dropped,
  and the skip link becomes English.
- `libs/`: the repository was built with a newer eXeLearning, so writing them would downgrade.

Hence **source-only saving**: `content.xml`, `content/resources/**` and `screenshot.png` are
authoritative. HTML, `libs/`, `idevices/`, `search_index.js` and `custom/` are publication
output, and `theme/` is the style's source.

## Tests and verification

- **Unit (25, `node --test`):**
  - ELPX round trip, path safety, entry and size limits, a declared-size zip bomb, the
    screenshot fix;
  - the save plan (source/published/protected, conflicts, removals);
  - target parsing, project loading (anonymous via raw, only import files, candidate folders);
  - commits (one tree on `base_tree`, deletions only when asked, rebase when other files
    moved, PR when the same files moved / protected / asked);
  - the Worker token endpoint (origin check, PKCE and `repository_id` forwarding,
    `redirect_uri` filtering, refresh, field filtering, not-configured);
  - the repository list (installations merged and paged, newest first), resource detection
    (root and subfolders, hidden folders skipped, empty repositories) and the workflow
    template.
- **E2E (`test/e2e.mjs`):** the real Worker through `wrangler dev` (app on `localhost`,
  editor on `127.0.0.1`, two real origins), the real editor in Chromium, and GitHub faked
  from the fixture:
  - opening via the badge URL;
  - the app cannot reach into the editor frame;
  - the Book style and images load;
  - an edit marks the project dirty, and Ctrl/Cmd+S opens the dialog listing only `content.xml`;
  - popup login sends the PKCE verifier and `repository_id: 42`;
  - one commit (one blob containing the edit, no `pp_screenshot`, parent `c1`, `PATCH` with
    `force: false`, every write with the bearer token);
  - a save without changes writes nothing;
  - "Open from GitHub" with a URL and authenticated reads.
- **Production, read-only:** `https://github.exelearning.dev/?repo=ateeducacion/exelearning-style-book`
  opens in about 6 s from real GitHub. The style installs and renders, and the preview runs
  through its service worker (`/editor/viewer/`). Nothing is written. Headers checked:
  editor CSP, app CSP, the editor host redirects to the app, and `/api/github/token`
  rejects other origins.
- **E2E also covers the rest of the cycle:**
  - a second change saved as a pull request: branch `exelearning/edit-…` from the last
    commit, base `main`, `main` not touched, the bar shows the new branch;
  - the Pages dialog: a GitHub "new file" link for `.github/workflows/exelearning-pages.yml`
    on `main`, the settings link and `https://teacher.github.io/libro/`;
  - "Your repositories": `teacher/libro` with its resource listed before `teacher/notas`;
  - signing in from the landing page.
- **Pages workflow:** `actionlint` is clean, for the root and for a subfolder. Its steps ran
  locally end to end (package, export with `exelearning/exelearning:v4.0.5` in about 3 s with
  the repository's own style, unzip). Not yet run on GitHub Actions.
- **GitHub App:** `exelearning` (owned by the exelearning organization) is registered and
  configured. With an invalid code, the token endpoint gets `bad_verification_code` from
  GitHub, so the secret and the exchange work. A real sign-in and commit are still to be
  done by a person.
