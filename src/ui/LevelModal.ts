import { TextRenderable, bold, fg, t } from "@opentui/core";
import { levelColor, ACTIVE_CURSOR } from "../format/highlight.js";
import { getTheme } from "../format/theme.js";
import { LEVELS, type Level } from "../protocol.js";
import { Modal } from "./Modal.js";

/** Highlighted choice in the level modal. Null = all (no gate). */
export type LevelChoice = Level | null;

const OPTIONS: readonly LevelChoice[] = [null, ...LEVELS];

/** `l` modal, rendered into the generic centered modal. */
export class LevelModal {
    private modal: Modal;
    private rowBoxes: TextRenderable[] = [];
    selected: LevelChoice = null;
    private onClose: (() => void) | null = null;

    constructor(private renderer: any) {
        this.modal = new Modal(renderer);
    }

    open(current: LevelChoice, cols: number, rows: number, onClose?: () => void): void {
        this.selected = current;
        this.onClose = onClose ?? null;
        this.modal.open(
            { cols, rows, width: Math.max(30, Math.min(cols - 2, 44)) },
            { onClose: () => this.close() },
        );
        this.paint();
    }

    close(): void {
        const dialog = this.modal.dialog;

        for (const row of this.rowBoxes.splice(0)) {
            try {
                (dialog as any)?.remove?.(row);
            } catch {
                // Already gone with a previous teardown.
            }

            (row as any).destroyRecursively?.() ?? (row as any).destroy?.();
        }

        const wasOpen = this.modal.isOpen;
        this.modal.close();

        if (wasOpen) {
            this.onClose?.();
        }
    }

    get isOpen(): boolean {
        return this.modal.isOpen;
    }

    /**
     * Rebuild rows from the current theme (same rule as HelpOverlay).
     * `paint()` already drops existing rows, so this is just refresh + paint.
     */
    repaint(): void {
        if (!this.modal.isOpen) {
            return;
        }

        this.modal.refreshTheme();
        this.paint();
    }

    /** Move the highlight, wrapping around the options. */
    move(delta: number): void {
        const n = OPTIONS.length;
        const cur = OPTIONS.indexOf(this.selected);
        const next = ((cur < 0 ? 0 : cur) + delta + n) % n;
        this.selected = OPTIONS[next] ?? null;
        this.paint();
    }

    private paint(): void {
        const dialog = this.modal.dialog;

        if (!this.modal.isOpen || !dialog) {
            return;
        }

        for (const row of this.rowBoxes.splice(0)) {
            try {
                (dialog as any).remove?.(row);
            } catch {
                // Already gone with a previous teardown.
            }

            (row as any).destroyRecursively?.() ?? (row as any).destroy?.();
        }

        const title = new TextRenderable(this.renderer, {
            content: t`${bold(fg(getTheme().text)("minimum level"))}`,
        } as any);
        (dialog as any).add(title as any);
        this.rowBoxes.push(title);

        for (const opt of OPTIONS) {
            const active = opt === this.selected;
            const theme = getTheme();
            const label = opt === null ? "all (show everything)" : opt;
            const cursor = active ? ACTIVE_CURSOR : "  ";
            const row = new TextRenderable(this.renderer, {
                content:
                    opt === null
                        ? t`${active ? fg(theme.accent)(cursor) : fg(theme.border)(cursor)}${active ? bold(fg(theme.text)(label)) : fg(theme.dim)(label)}`
                        : t`${active ? fg(theme.accent)(cursor) : fg(theme.border)(cursor)}${active ? bold(fg(levelColor(opt, theme))(label)) : fg(levelColor(opt, theme))(label)}`,
            } as any);
            (dialog as any).add(row as any);
            this.rowBoxes.push(row);
        }

        const hint = new TextRenderable(this.renderer, {
            content: t`${fg(getTheme().dim)("↑↓ choose · Enter confirms · Esc cancels")}`,
        } as any);
        (dialog as any).add(hint as any);
        this.rowBoxes.push(hint);
    }

    destroy(): void {
        this.close();
        this.modal.destroy();
    }
}
