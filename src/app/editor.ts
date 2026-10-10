// The official eXeLearning static editor in a cross-origin iframe, driven by its postMessage
// embedding protocol (eXeLearning doc/development/embedding.md).

type Message = { type: string; requestId?: string; [key: string]: unknown };

export class EditorFrame {
    readonly iframe = document.createElement('iframe');
    private readonly origin: string;
    private readonly waiting = new Map<string, { resolve(m: Message): void; reject(e: Error): void; done: string; fail: string }>();
    onDirty = () => {};
    onSaveShortcut = () => {};

    constructor(container: HTMLElement, editorOrigin: string) {
        this.origin = editorOrigin;
        this.iframe.title = 'eXeLearning';
        this.iframe.allow = 'clipboard-read; clipboard-write; fullscreen';
        this.iframe.src = `${editorOrigin}/editor/embed.html?parent=${encodeURIComponent(location.origin)}`;
        window.addEventListener('message', this.onMessage);
        container.replaceChildren(this.iframe);
    }

    private onMessage = (event: MessageEvent) => {
        const message = event.data as Message;
        if (event.source !== this.iframe.contentWindow || event.origin !== this.origin || typeof message?.type !== 'string') return;
        if (message.type === 'EXELEARNING_EVENT' && message.event === 'PROJECT_DIRTY') this.onDirty();
        if (message.type === 'SAVE_SHORTCUT') this.onSaveShortcut();
        for (const [key, pending] of this.waiting) {
            const requestId = key.split(' ')[1];
            if (requestId && requestId !== message.requestId) continue;
            if (message.type === pending.done) {
                this.waiting.delete(key);
                pending.resolve(message);
            } else if (message.type === pending.fail) {
                this.waiting.delete(key);
                pending.reject(new Error(String(message.error ?? message.type)));
            }
        }
    };

    private wait(done: string, fail: string, requestId = '', timeoutMs = 120_000): Promise<Message> {
        return new Promise((resolve, reject) => {
            const key = `${done} ${requestId}`.trim();
            const timer = setTimeout(() => {
                this.waiting.delete(key);
                reject(new Error(`The eXeLearning editor did not answer (${done}).`));
            }, timeoutMs);
            this.waiting.set(key, {
                done,
                fail,
                resolve: (m) => {
                    clearTimeout(timer);
                    resolve(m);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
        });
    }

    private post(message: Message, transfer: Transferable[] = []) {
        this.iframe.contentWindow?.postMessage(message, this.origin, transfer);
    }

    ready = this.wait('EXELEARNING_READY', '', '', 180_000);

    async open(bytes: Uint8Array, filename: string): Promise<void> {
        await this.ready;
        const requestId = crypto.randomUUID();
        const done = this.wait('OPEN_FILE_SUCCESS', 'OPEN_FILE_ERROR', requestId);
        const buffer = bytes.slice().buffer;
        this.post({ type: 'OPEN_FILE', requestId, data: { bytes: buffer, filename } }, [buffer]);
        await done;
    }

    /** Current project as .elpx bytes. REQUEST_SAVE fails in released builds; REQUEST_EXPORT works. */
    async exportElpx(): Promise<{ bytes: Uint8Array; requestId: string }> {
        const requestId = crypto.randomUUID();
        const done = this.wait('EXPORT_FILE', 'REQUEST_EXPORT_ERROR', requestId);
        this.post({ type: 'REQUEST_EXPORT', requestId, data: { format: 'elpx' } });
        const reply = await done;
        if (!(reply.bytes instanceof ArrayBuffer)) throw new Error('The editor returned an export without bytes.');
        return { bytes: new Uint8Array(reply.bytes), requestId };
    }

    /** Mark the editor clean, unless it changed after that export (handled by the adapter). */
    markClean(requestId: string): void {
        this.post({ type: 'MARK_CLEAN', requestId });
    }
}
