// GitHub redirects the login / installation popup here; hand the parameters to the opener (same origin).
if (window.opener) {
    window.opener.postMessage({ type: 'github-callback', search: location.search }, location.origin);
} else {
    // Installation started outside the app: go to the app itself.
    location.replace('/');
}
