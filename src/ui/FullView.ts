import { TextRenderable, bold, fg, t } from "@opentui/core";
import { authLabel, originLabel } from "../format/cards.js";
import { formatTs, levelColor } from "../format/highlight.js";
import { expandQueryPrefix } from "../format/queryPrefix.js";
import { getTheme } from "../format/theme.js";
import type { LogEvent } from "../protocol.js";
import { Modal } from "./Modal.js";

/** Hard cap so one huge event (SQL dumps) cannot OOM the modal. */
export const FULL_VIEW_MAX_ROWS = 500;

/** Visible content rows inside the dialog for a terminal of `totalRows`. */
export function fullViewport(totalRows: number, lineCount: number): number {
    return Math.max(5, Math.min(lineCount, totalRows - 12));
}

/** Dialog width: wide enough for queries, with dim visible on the sides. */
export function fullDialogWidth(totalCols: number): number {
    return Math.max(40, Math.min(totalCols - 4, 90));
}

function metaRecord(ev: LogEvent): Record<string, unknown> {
    return (ev.meta ?? {}) as Record<string, unknown>;
}

function formatValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

/**
 * Display name for one event: log-file basename when known, else the
 * attributed engine. Raw collector source ids (`cake_live`, …) are internal
 * transport names and never shown.
 */
export function logName(ev: LogEvent): string | null {
    const meta = metaRecord(ev);
    const file = meta.file;
    const engine = meta.engine;

    if (typeof file === "string" && file !== "") {
        return file;
    }

    if (typeof engine === "string" && engine !== "") {
        return engine;
    }

    return null;
}

/**
 * Plain-text body for one event: the dialog title already carries the header
 * (time + level + log name), so the body starts straight with the full
 * multi-line message, then sections only when present (origin/auth/context/
 * exception). The decoded payload already carries everything, so the raw
 * transport line is not shown. Capped at `FULL_VIEW_MAX_ROWS` with a
 * truncation tail.
 */
export function buildFullLines(ev: LogEvent): string[] {
    // Query-logger attributes get their own first line, statement follows.
    const lines: string[] = [...expandQueryPrefix(ev.msg)];

    const meta = metaRecord(ev);
    const originRaw = meta.origin;
    const origin: Record<string, unknown> =
        typeof originRaw === "object" && originRaw !== null ? (originRaw as Record<string, unknown>) : {};
    const originText = originLabel(origin);

    if (originText !== null) {
        lines.push("");
        lines.push(`origin: ${originText}`);

        if (origin.type === "http") {
            lines.push(`auth: ${authLabel(origin)}`);
        }
    }

    const context = meta.context;
    if (typeof context === "object" && context !== null) {
        const entries = Object.entries(context as Record<string, unknown>);
        if (entries.length > 0) {
            lines.push("");
            lines.push("context:");
            for (const [key, value] of entries) {
                lines.push(`  ${key}: ${formatValue(value)}`);
            }
        }
    }

    const ex = meta.exception;
    if (typeof ex === "object" && ex !== null) {
        const rec = ex as Record<string, unknown>;
        const cls = typeof rec.class === "string" && rec.class !== "" ? rec.class : null;
        const message = typeof rec.message === "string" && rec.message !== "" ? rec.message : null;
        if (cls !== null || message !== null) {
            lines.push("");
            lines.push(`exception: ${[cls, message].filter((s) => s !== null).join(": ")}`);
        }
        const trace = rec.trace;
        if (Array.isArray(trace)) {
            let n = 0;
            for (const frame of trace) {
                if (n >= 50) {
                    break;
                }
                if (typeof frame === "object" && frame !== null) {
                    const f = frame as Record<string, unknown>;
                    lines.push(`  #${n + 1} ${String(f.file ?? "?")}:${String(f.line ?? "?")}`);
                    n++;
                }
            }
        }
    }

    if (lines.length > FULL_VIEW_MAX_ROWS) {
        const hidden = lines.length - FULL_VIEW_MAX_ROWS;
        return [...lines.slice(0, FULL_VIEW_MAX_ROWS), `… (${hidden} more truncated)`];
    }

    return lines;
}

/** Usable text width inside the dialog: border (2) + side padding (2). */
export function fullInnerWidth(totalCols: number): number {
    return Math.max(20, fullDialogWidth(totalCols) - 4);
}

/**
 * Content lines wrapped to the dialog width, so every visual row is exactly
 * one terminal row: nothing spills past the frame and the dialog height
 * stays stable while scrolling.
 */
export function fullContentLines(ev: LogEvent, innerWidth: number): string[] {
    const w = Math.max(20, Math.floor(innerWidth));
    const out: string[] = [];

    for (const line of buildFullLines(ev)) {
        if (line === "") {
            out.push("");
            continue;
        }

        let rest = line;

        while (rest.length > w) {
            out.push(rest.slice(0, w));
            rest = rest.slice(w);
        }

        out.push(rest);
    }

    return out;
}

/** Last valid scroll offset for one event at the current terminal size. */
export function fullMaxScroll(ev: LogEvent, totalCols: number, totalRows: number): number {
    const lines = fullContentLines(ev, fullInnerWidth(totalCols));
    return Math.max(0, lines.length - fullViewport(totalRows, lines.length));
}

/**
 * Full event view: one event rendered into the generic `Modal` with its own
 * scroll window. The host owns the event + offset; the modal only paints.
 */
export class FullView {
    private modal: Modal;
    private rows: TextRenderable[] = [];

    constructor(private renderer: any) {
        this.modal = new Modal(renderer);
    }

    get isOpen(): boolean {
        return this.modal.isOpen;
    }

    open(
        ev: LogEvent,
        scrollOffset: number,
        cols: number,
        rows: number,
        hooks: { onClose: () => void; onScroll?: (delta: number) => void },
    ): void {
        this.modal.open({ cols, rows, width: fullDialogWidth(cols) }, hooks);
        this.paint(ev, scrollOffset, cols, rows);
    }

    paint(ev: LogEvent, scrollOffset: number, totalCols: number, totalRows: number): void {
        const dialog = this.modal.dialog;
        if (!this.modal.isOpen || !dialog) {
            return;
        }

        // Runs on every host render while open: picks up theme toggles too.
        this.modal.refreshTheme();

        for (const row of this.rows.splice(0)) {
            try {
                (dialog as any).remove?.(row);
            } catch {
                // Already gone with a previous teardown.
            }

            (row as any).destroyRecursively?.() ?? (row as any).destroy?.();
        }

        const lines = fullContentLines(ev, fullInnerWidth(totalCols));
        const vp = fullViewport(totalRows, lines.length);
        const max = Math.max(0, lines.length - vp);
        const start = Math.max(0, Math.min(scrollOffset, max));
        const theme = getTheme();
        const color = levelColor(ev.level, theme);
        const name = logName(ev);

        const title = new TextRenderable(this.renderer, {
            content: t`${bold(fg(color)(ev.level.toUpperCase()))}${fg(theme.dim)(` · ${formatTs(ev.ts)}${name !== null ? ` · ${name}` : ""}`)}`,
        } as any);
        (dialog as any).add(title as any);
        this.rows.push(title);

        const window = lines.slice(start, start + vp);

        // Pad short tails with blanks so the frame keeps one height.
        while (window.length < vp) {
            window.push("");
        }

        for (const line of window) {
            const row = new TextRenderable(this.renderer, {
                content: t`${fg(theme.text)(line === "" ? " " : line)}`,
            } as any);
            (dialog as any).add(row as any);
            this.rows.push(row);
        }

        const hint = new TextRenderable(this.renderer, {
            content: t`${fg(theme.dim)(` ${start + 1}-${Math.min(lines.length, start + vp)}/${lines.length} · ↑↓ scroll · Esc closes `)}`,
        } as any);
        (dialog as any).add(hint as any);
        this.rows.push(hint);
    }

    close(): void {
        for (const row of this.rows.splice(0)) {
            try {
                (row as any).destroyRecursively?.() ?? (row as any).destroy?.();
            } catch {
                // Teardown best-effort.
            }
        }

        this.modal.close();
    }

    destroy(): void {
        this.close();
        this.modal.destroy();
    }
}
