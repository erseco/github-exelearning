// GitHub App manifest flow (scripts/register-github-app.html) lands here with a one-time code.
(document.getElementById('code') as HTMLInputElement).value = new URLSearchParams(location.search).get('code') ?? '';
