import { BoxRenderable, ScrollBoxRenderable, TextRenderable, t, fg } from "@opentui/core";
import { detach } from "./detach.js";
import { thumbRange } from "./scrollbar.js";
import { formatTs, levelColor, ACTIVE_CURSOR } from "../format/highlight.js";
import { stripQueryPrefix } from "../format/queryPrefix.js";
import { getTheme } from "../format/theme.js";
import type { LogEvent } from "../protocol.js";

/** Virtualized-ish list: renders the visible window only (never the whole buffer). */
export class LogList {
    private scrollBox: ScrollBoxRenderable;
    /** Our own row boxes. ScrollBox.add() forwards to an inner content box,
     * so `scrollBox.children` lists its internals (wrapper, scrollbars) —
     * clearing by that would destroy the ScrollBox itself (seen: duplicated
     * rows, multiple ▸ cursors, scrollbar fragments). Track rows instead. */
    private rowBoxes: BoxRenderable[] = [];
    /** Current rendered row count, so App can compute scroll bounds. */
    rowCount = 0;
    /** Click a row opens the full-view modal (row index syncs the cursor). */
    onOpen: ((ev: LogEvent, index: number) => void) | null = null;

    constructor(
        private renderer: any,
        parent: { add: (child: any) => void },
    ) {
        this.scrollBox = new ScrollBoxRenderable(renderer, {
            id: "log-list",
            rootOptions: { backgroundColor: getTheme().background },
            viewportOptions: { backgroundColor: getTheme().background },
            contentOptions: { backgroundColor: getTheme().background },
            // Native thumb never moves: we render a windowed slice whose
            // content fits the viewport, so the native range is ~0. Our own
            // thumb column (per-row, multiplex style) tracks scrollOffset.
            scrollbarOptions: { visible: false, showArrows: false },
            verticalScrollbarOptions: { visible: false, showArrows: false },
            horizontalScrollbarOptions: { visible: false, showArrows: false },
        } as any);
        parent.add(this.scrollBox);
        // Options alone do not hide the bars: a wrapped long row overflows
        // the viewport for a frame and the native thumb sticks on top.
        this.scrollBox.verticalScrollBar.visible = false;
        this.scrollBox.horizontalScrollBar.visible = false;
    }

    setVisible(v: boolean): void {
        (this.scrollBox as any).visible = v;
    }

    render(
        rows: readonly LogEvent[],
        scrollOffset: number,
        viewportRows: number,
        activeIndex: number,
        lineWidth: number,
    ): void {
        for (const box of this.rowBoxes.splice(0)) {
            try {
                (this.scrollBox as any).remove?.(box);
            } catch {
                // Already gone with a previous teardown.
            }

            (box as any).destroyRecursively?.() ?? (box as any).destroy?.();
        }

        const theme = getTheme();
        // Re-apply every frame: theme:toggle only flips the registry, the
        // ScrollBox keeps whatever background it was constructed with.
        this.scrollBox.rootOptions = { backgroundColor: theme.background };
        this.scrollBox.viewportOptions = { backgroundColor: theme.background };
        this.scrollBox.contentOptions = { backgroundColor: theme.background };
        this.rowCount = rows.length;
        const start = Math.max(0, Math.min(scrollOffset, Math.max(0, rows.length - viewportRows)));
        const visible = rows.slice(start, start + viewportRows);
        const thumb = thumbRange(rows.length, viewportRows, scrollOffset);

        for (let i = 0; i < visible.length; i++) {
            const ev = visible[i];

            if (!ev) {
                continue;
            }

            const globalIndex = start + i;
            const active = globalIndex === activeIndex;
            const box = new BoxRenderable(this.renderer, {
                id: `row-${globalIndex}`,
                width: "100%",
                flexDirection: "row",
                backgroundColor: active ? theme.border : i % 2 === 0 ? theme.background : theme.panel,
            } as any);
            (box as any).onMouseDown = () => this.onOpen?.(ev, globalIndex);
            const textWrap = new BoxRenderable(this.renderer, {
                id: `row-${globalIndex}-text`,
                flexGrow: 1,
                backgroundColor: active ? theme.border : i % 2 === 0 ? theme.background : theme.panel,
            } as any);
            const text = new TextRenderable(this.renderer, {
                content: this.lineContent(ev, active, globalIndex, lineWidth),
            } as any);
            textWrap.add(text);
            box.add(textWrap);
            const inThumb = thumb.show && i >= thumb.start && i < thumb.end;
            const thumbText = new TextRenderable(this.renderer, {
                content: inThumb ? t`${fg(theme.dim)("┃")}` : t`${fg(theme.border)("│")}`,
            } as any);
            box.add(thumbText);
            (this.scrollBox as any).add(box);
            this.rowBoxes.push(box);
        }
    }

    private lineContent(ev: LogEvent, active: boolean, index: number, lineWidth: number) {
        const theme = getTheme();
        const color = levelColor(ev.level, theme);
        // Gutter reservation: always 2 cells (» active, two spaces
        // inactive) so the active row never shifts or changes width budget.
        const head = `${ACTIVE_CURSOR}${formatTs(ev.ts)} ${ev.level.toUpperCase().padEnd(9, " ")} `;
        const tail = ` #${index}`;
        const first = stripQueryPrefix(ev.msg).split("\n")[0] ?? "";
        const room = Math.max(0, lineWidth - head.length - tail.length);
        const msg = first.length > room ? (room <= 1 ? "" : `${first.slice(0, room - 1)}…`) : first;

        return t`${active ? fg(theme.accent)(ACTIVE_CURSOR) : fg(theme.border)("  ")}${fg(theme.dim)(formatTs(ev.ts))} ${fg(color)(ev.level.toUpperCase().padEnd(9, " "))} ${fg(theme.text)(msg)}${fg(theme.border)(` #${index}`)}`;
    }

    destroy(): void {
        for (const box of this.rowBoxes.splice(0)) {
            box.destroy();
        }

        detach((this.scrollBox as any).parent, this.scrollBox);

        (this.scrollBox as any).destroyRecursively?.() ?? (this.scrollBox as any).destroy?.();
    }
}
