// Decide what a save writes back to the uncompressed project. Pure module (no `vscode`).
import type { Files } from './elpx.ts';

/**
 * - source: what the importer reads back; always written when changed.
 * - published: rendered output (HTML, libs, iDevice assets); written only on request.
 * - protected: theme/ is the style's source in style repositories; never overwritten.
 */
export type Kind = 'source' | 'published' | 'protected';

export function classify(path: string): Kind {
    if (path === 'content.xml' || path === 'screenshot.png' || path.startsWith('content/resources/')) return 'source';
    if (path.startsWith('theme/')) return 'protected';
    return 'published';
}

export interface SavePlan {
    /** Added or modified files to write, content.xml last. */
    write: string[];
    /** Changed in the export but not written (published or protected). */
    stale: string[];
    /** Source files present when opened that the export no longer contains. */
    removed: string[];
    /** Files to write whose workspace copy changed since the project was opened. */
    conflicts: string[];
    unchanged: number;
}

export function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/**
 * @param exported files of the .elpx returned by the editor
 * @param current  workspace bytes now, for every exported or opened path that exists
 * @param opened   source files as read when the project was opened
 */
export function planSave(exported: Files, current: Files, opened: Files, writePublished = false): SavePlan {
    const plan: SavePlan = { write: [], stale: [], removed: [], conflicts: [], unchanged: 0 };
    for (const [path, bytes] of exported) {
        if (sameBytes(bytes, current.get(path))) {
            plan.unchanged++;
            continue;
        }
        const kind = classify(path);
        if (kind === 'protected' || (kind === 'published' && !writePublished)) {
            plan.stale.push(path);
            continue;
        }
        plan.write.push(path);
        const changedSinceOpen = opened.has(path)
            ? !sameBytes(opened.get(path), current.get(path))
            : kind === 'source' && current.has(path);
        if (changedSinceOpen) plan.conflicts.push(path);
    }
    for (const path of opened.keys()) {
        if (classify(path) === 'source' && !exported.has(path) && current.has(path)) plan.removed.push(path);
    }
    // Assets first, content.xml last: a failed save never leaves content.xml pointing at missing files.
    plan.write.sort((a, b) => Number(a === 'content.xml') - Number(b === 'content.xml'));
    return plan;
}
