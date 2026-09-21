import { BoxRenderable, RGBA } from "@opentui/core";
import { getTheme } from "../format/theme.js";
import { detach } from "./detach.js";

export interface ModalHooks {
    /** Backdrop click (outside the dialog). */
    onClose: () => void;
    /** Wheel scroll over the backdrop or dialog. */
    onScroll?: (delta: number) => void;
}

export interface ModalLayout {
    /** Terminal size in cells. */
    cols: number;
    rows: number;
    /** Dialog width in cells (default: fits the terminal with dim visible). */
    width?: number;
    borderColor?: string;
    backgroundColor?: string;
}

/**
 * Generic centered modal (opencode `Dialog` pattern): a full-screen absolute
 * dim backdrop over `renderer.root` with one centered dialog box inside it.
 * Outside click closes, clicks and wheel inside never leak to the backdrop.
 * Callers fill `dialog` with their own rows and repaint on scroll.
 */
export class Modal {
    private backdrop: BoxRenderable | null = null;
    private box: BoxRenderable | null = null;
    private visible = false;
    private lastLayout: ModalLayout | null = null;

    constructor(private renderer: any) {}

    get isOpen(): boolean {
        return this.visible;
    }

    /** The dialog box to fill (null when closed). */
    get dialog(): BoxRenderable | null {
        return this.box;
    }

    open(layout: ModalLayout, hooks: ModalHooks): BoxRenderable {
        this.close();
        this.visible = true;

        const theme = getTheme();
        const cols = Math.max(20, Math.floor(layout.cols));
        const rows = Math.max(10, Math.floor(layout.rows));

        this.backdrop = new BoxRenderable(this.renderer, {
            id: "modal-backdrop",
            position: "absolute",
            left: 0,
            top: 0,
            width: cols,
            height: rows,
            alignItems: "center",
            paddingTop: Math.max(1, Math.floor(rows / 6)),
            backgroundColor: RGBA.fromInts(0, 0, 0, 150),
            zIndex: 100,
        } as any);
        (this.backdrop as any).onMouseDown = () => hooks.onClose();
        (this.backdrop as any).onMouse = (e: any) => {
            if (e?.type !== "scroll" || !hooks.onScroll) {
                return;
            }

            const dir = e?.scroll?.direction;
            if (dir === "up" || dir === "down") {
                hooks.onScroll(dir === "up" ? -3 : 3);
            }
        };

        this.box = new BoxRenderable(this.renderer, {
            id: "modal-dialog",
            width: layout.width ?? Math.max(40, Math.min(cols - 4, 80)),
            border: true,
            borderColor: layout.borderColor ?? theme.accent,
            backgroundColor: layout.backgroundColor ?? theme.panel,
            paddingLeft: 1,
            paddingRight: 1,
        } as any);
        (this.box as any).onMouseDown = (e: any) => e?.stopPropagation?.();
        (this.box as any).onMouse = (e: any) => {
            if (e?.type !== "scroll" || !hooks.onScroll) {
                return;
            }

            const dir = e?.scroll?.direction;
            if (dir === "up" || dir === "down") {
                e?.stopPropagation?.();
                hooks.onScroll(dir === "up" ? -3 : 3);
            }
        };

        this.backdrop.add(this.box as any);
        this.renderer.root.add(this.backdrop as any);
        this.lastLayout = layout;
        return this.box;
    }

    /**
     * Re-apply dialog colors from the current theme without rebuilding rows.
     * Called when the theme toggles while the modal is open (colors are
     * otherwise frozen at open time). Explicit layout overrides win.
     */
    refreshTheme(): void {
        if (!this.visible || !this.box || !this.lastLayout) {
            return;
        }

        const theme = getTheme();
        this.box.borderColor = this.lastLayout.borderColor ?? theme.accent;
        this.box.backgroundColor = this.lastLayout.backgroundColor ?? theme.panel;
    }

    close(): void {
        if (!this.visible) {
            return;
        }

        this.visible = false;
        this.lastLayout = null;

        if (this.backdrop) {
            detach(this.renderer.root, this.backdrop);
            (this.backdrop as any).destroyRecursively?.() ?? (this.backdrop as any).destroy?.();
            this.backdrop = null;
        }

        this.box = null;
    }

    destroy(): void {
        this.close();
    }
}
