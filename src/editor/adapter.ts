// Runs inside editor/embed.html (the official static editor, editor origin). Fills gaps of the
// released EmbeddingBridge (eXeLearning <= 4.0.5): PROJECT_DIRTY is never emitted, there is no
// way to mark the project clean after the host saved it, and Ctrl/Cmd+S downloads a file.
// Remove the dirty/clean part once the editor emits PROJECT_DIRTY/PROJECT_SAVED itself.
const host = window.parent;
const requested = new URLSearchParams(location.search).get('parent') ?? '';
// Only talk to an app origin listed in the embedding config baked into embed.html.
const trusted: string[] = (window as any).__EXE_EMBEDDING_CONFIG__?.trustedOrigins ?? [];
const parentOrigin = trusted.includes(requested) ? requested : undefined;
const send = (message: object) => parentOrigin && host.postMessage(message, parentOrigin);

type DocumentManager = {
    isDirty: boolean;
    ydoc?: { on(event: 'update', fn: () => void): void };
    on(event: 'saveStatus', fn: (status: { status: string }) => void): void;
    markClean(): void;
};
const manager = (): DocumentManager | undefined => (window as any).eXeLearning?.app?.project?._yjsBridge?.documentManager;

let watched: DocumentManager | undefined;
let revision = 0; // bumped on every document change
const exportRevisions = new Map<string, number>();

// The document manager is created during start-up; poll until it exists (and if it is replaced).
setInterval(() => {
    const current = manager();
    if (!current || current === watched) return;
    watched = current;
    current.ydoc?.on('update', () => revision++);
    current.on('saveStatus', ({ status }) => {
        if (status === 'dirty') send({ type: 'EXELEARNING_EVENT', event: 'PROJECT_DIRTY', data: { isDirty: true } });
    });
}, 500);

window.addEventListener('message', (event) => {
    if (event.source !== host || event.origin !== parentOrigin) return;
    const { type, requestId } = event.data ?? {};
    if (type === 'REQUEST_EXPORT') exportRevisions.set(requestId, revision);
    if (type === 'MARK_CLEAN') {
        // Only if nothing changed since that export was taken; otherwise the host stays dirty.
        if (exportRevisions.get(requestId) === revision) manager()?.markClean();
        else send({ type: 'EXELEARNING_EVENT', event: 'PROJECT_DIRTY', data: { isDirty: true } });
        exportRevisions.delete(requestId);
    }
});

window.addEventListener(
    'keydown',
    (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
            event.preventDefault();
            event.stopImmediatePropagation();
            send({ type: 'SAVE_SHORTCUT' });
        }
    },
    true,
);
