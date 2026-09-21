import { BoxRenderable, StyledText, TextRenderable, bold, fg, t } from "@opentui/core";
import { HELP_SECTIONS, type HelpSection } from "../input/keys.js";
import { getTheme } from "../format/theme.js";
import { Modal } from "./Modal.js";

export const HELP_TITLE = "cake logs tui — keys";

/** Left column sections, right column sections (balanced by row count). */
const LEFT_SECTIONS: readonly HelpSection[] = HELP_SECTIONS.slice(0, 4);
const RIGHT_SECTIONS: readonly HelpSection[] = HELP_SECTIONS.slice(4);
const COLUMN_GAP = 4;

/** Hotkey column width: longest key combo, so descriptions align. */
function keyColumnWidth(): number {
    let max = 0;

    for (const section of HELP_SECTIONS) {
        for (const item of section.items) {
            max = Math.max(max, item.keys.length);
        }
    }

    return max;
}

/** Plain-text width of one column (indent + keys + descriptions). */
function columnWidth(sections: readonly HelpSection[], keyCol: number): number {
    let max = 0;

    for (const section of sections) {
        max = Math.max(max, section.title.length);

        for (const item of section.items) {
            max = Math.max(max, 2 + keyCol + 2 + item.desc.length);
        }
    }

    return max;
}

/** Dialog width: both columns + gap + frame, capped to the terminal. */
export function helpDialogWidth(totalCols: number): number {
    const keyCol = keyColumnWidth();
    const body = columnWidth(LEFT_SECTIONS, keyCol) + COLUMN_GAP + columnWidth(RIGHT_SECTIONS, keyCol);

    return Math.max(40, Math.min(totalCols - 4, Math.max(HELP_TITLE.length, body) + 6));
}

type Chunk = ReturnType<ReturnType<typeof fg>>;

/** `?` overlay, rendered into the generic centered modal. */
export class HelpOverlay {
    private modal: Modal;
    /** Top-level dialog children (destroyRecursively covers nested rows). */
    private rows: (BoxRenderable | TextRenderable)[] = [];

    constructor(private renderer: any) {
        this.modal = new Modal(renderer);
    }

    open(cols: number, rows: number, onClose?: () => void): void {
        this.modal.open({ cols, rows, width: helpDialogWidth(cols) }, { onClose: () => this.close(onClose) });
        this.paint();
    }

    toggle(cols: number, rows: number, onClose?: () => void): boolean {
        if (this.modal.isOpen) {
            this.close(onClose);
        } else {
            this.open(cols, rows, onClose);
        }

        return this.modal.isOpen;
    }

    close(onClose?: () => void): void {
        const dialog = this.modal.dialog;

        for (const row of this.rows.splice(0)) {
            try {
                (dialog as any)?.remove?.(row);
            } catch {
                // Already gone with a previous teardown.
            }

            (row as any).destroyRecursively?.() ?? (row as any).destroy?.();
        }

        this.modal.close();
        onClose?.();
    }

    get isOpen(): boolean {
        return this.modal.isOpen;
    }

    /**
     * Rebuild rows from the current theme. Called from `App.render()` when
     * the overlay is open so `theme:toggle` recolors it without closing.
     */
    repaint(): void {
        if (!this.modal.isOpen) {
            return;
        }

        const dialog = this.modal.dialog;

        for (const row of this.rows.splice(0)) {
            try {
                (dialog as any)?.remove?.(row);
            } catch {
                // Already gone with a previous teardown.
            }

            (row as any).destroyRecursively?.() ?? (row as any).destroy?.();
        }

        this.modal.refreshTheme();
        this.paint();
    }

    private paint(): void {
        const dialog = this.modal.dialog;

        if (!this.modal.isOpen || !dialog) {
            return;
        }

        const theme = getTheme();
        const keyCol = keyColumnWidth();

        const title = new TextRenderable(this.renderer, {
            content: t`${bold(fg(theme.text)(HELP_TITLE))}`,
        } as any);
        (dialog as any).add(title as any);
        this.rows.push(title);

        const body = new BoxRenderable(this.renderer, {
            id: "help-columns",
            flexDirection: "row",
            width: "100%",
        } as any);
        (dialog as any).add(body as any);
        this.rows.push(body);

        const left = new BoxRenderable(this.renderer, {
            id: "help-left",
            flexDirection: "column",
            width: columnWidth(LEFT_SECTIONS, keyCol),
        } as any);
        (body as any).add(left as any);

        const right = new BoxRenderable(this.renderer, {
            id: "help-right",
            flexDirection: "column",
            // Border-box: padding shrinks the content area, so the gap
            // is added to the width to keep text unclipped.
            width: columnWidth(RIGHT_SECTIONS, keyCol) + COLUMN_GAP,
            paddingLeft: COLUMN_GAP,
        } as any);
        (body as any).add(right as any);

        for (const [sections, column] of [
            [LEFT_SECTIONS, left],
            [RIGHT_SECTIONS, right],
        ] as const) {
            for (const section of sections) {
                const heading = new TextRenderable(this.renderer, {
                    content: t`${bold(fg(theme.text)(section.title))}`,
                } as any);
                (column as any).add(heading as any);

                for (const item of section.items) {
                    const chunks: Chunk[] = [
                        fg(theme.dim)("  "),
                        bold(fg(theme.accent)(item.keys.padEnd(keyCol, " "))),
                        fg(theme.dim)(`  ${item.desc}`),
                    ];
                    const row = new TextRenderable(this.renderer, { content: new StyledText(chunks) } as any);
                    (column as any).add(row as any);
                }
            }
        }

        const hint = new TextRenderable(this.renderer, {
            content: t`${fg(theme.dim)("Press ? or Esc to close")}`,
        } as any);
        (dialog as any).add(hint as any);
        this.rows.push(hint);
    }

    destroy(): void {
        this.close();
        this.modal.destroy();
    }
}
