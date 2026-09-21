import { BoxRenderable, ScrollBoxRenderable, StyledText, TextRenderable, bold, fg, t } from "@opentui/core";
import { cardStarts, describeCard, effectiveWrapWidth, renderCardWrapped } from "../format/cards.js";
import { detach } from "./detach.js";
import { thumbRange } from "./scrollbar.js";
import { levelColor, ACTIVE_CURSOR } from "../format/highlight.js";
import { getTheme } from "../format/theme.js";
import type { LogEvent } from "../protocol.js";

/** Usable card-body width: terminal minus sidebar, borders and `│ ` prefix. */
export function cardBodyWidth(totalCols: number, sidebarWidth: number): number {
    return Math.max(20, totalCols - sidebarWidth - 8);
}

/**
 * Card list: Phase-1 `CliPrinter` cards flattened to lines, so scroll/follow
 * math stays line-based and identical to the lines view. The `»` match cursor
 * lands on whichever card line is active. Long body/footer lines wrap —
 * counting (`cardStarts`) and emission both use the wrapped screen rows so
 * one entry always maps to whole screen rows.
 */
export class CardList {
    private scrollBox: ScrollBoxRenderable;
    /** Own row boxes — see LogList: `scrollBox.children` lists internals, never our rows. */
    private rowBoxes: BoxRenderable[] = [];
    /** Click a card row opens the full-view modal (event index syncs the cursor). */
    onOpen: ((ev: LogEvent, index: number) => void) | null = null;

    constructor(
        private renderer: any,
        parent: BoxRenderable,
    ) {
        this.scrollBox = new ScrollBoxRenderable(renderer, {
            id: "card-list",
            rootOptions: { backgroundColor: getTheme().background },
            viewportOptions: { backgroundColor: getTheme().background },
            contentOptions: { backgroundColor: getTheme().background },
            // Own thumb column (see LogList) — the native thumb never moves on windowed content.
            scrollbarOptions: { visible: false, showArrows: false },
            verticalScrollbarOptions: { visible: false, showArrows: false },
            horizontalScrollbarOptions: { visible: false, showArrows: false },
        } as any);
        parent.add(this.scrollBox as any);
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
        activeLine: number,
        bodyWidth: number,
        lineWidth?: number,
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
        // Same stale-background rule as LogList: re-apply every frame.
        this.scrollBox.rootOptions = { backgroundColor: theme.background };
        this.scrollBox.viewportOptions = { backgroundColor: theme.background };
        this.scrollBox.contentOptions = { backgroundColor: theme.background };
        const wrapWidth = lineWidth !== undefined ? effectiveWrapWidth(lineWidth) : bodyWidth;
        const { total } = cardStarts(rows, bodyWidth, lineWidth);
        const start = Math.max(0, Math.min(scrollOffset, Math.max(0, total - viewportRows)));
        const end = start + viewportRows;
        const thumb = thumbRange(total, viewportRows, scrollOffset);

        let line = 0;
        let emitted = 0;

        for (let eventIndex = 0; eventIndex < rows.length; eventIndex++) {
            const ev = rows[eventIndex];
            const lines = renderCardWrapped(describeCard(ev, bodyWidth), wrapWidth);

            for (const raw of lines) {
                const globalIndex = line++;
                const current = ev;
                const currentEventIndex = eventIndex;

                if (globalIndex < start || globalIndex >= end) {
                    continue;
                }

                const active = globalIndex === activeLine;
                const box = new BoxRenderable(this.renderer, {
                    id: `card-row-${globalIndex}`,
                    width: "100%",
                    flexDirection: "row",
                    backgroundColor: active ? theme.border : theme.background,
                } as any);
                (box as any).onMouseDown = () => this.onOpen?.(current, currentEventIndex);
                const textWrap = new BoxRenderable(this.renderer, {
                    id: `card-row-${globalIndex}-text`,
                    flexGrow: 1,
                    backgroundColor: active ? theme.border : theme.background,
                } as any);
                const text = new TextRenderable(this.renderer, {
                    content: toFlatLine(ev, raw, active, lineWidth),
                } as any);
                textWrap.add(text);
                box.add(textWrap);
                const shown = emitted;
                const inThumb = thumb.show && shown >= thumb.start && shown < thumb.end;
                const thumbText = new TextRenderable(this.renderer, {
                    content: inThumb ? t`${fg(theme.dim)("┃")}` : t`${fg(theme.border)("│")}`,
                } as any);
                box.add(thumbText);
                (this.scrollBox as any).add(box);
                this.rowBoxes.push(box);
                emitted++;
            }

            if (line >= end) {
                break;
            }
        }

        void emitted;
    }

    destroy(): void {
        for (const box of this.rowBoxes.splice(0)) {
            box.destroy();
        }

        detach((this.scrollBox as any).parent, this.scrollBox);

        (this.scrollBox as any).destroyRecursively?.() ?? (this.scrollBox as any).destroy?.();
    }
}

/**
 * One styled card line, assembled chunk-by-chunk. Never nest a StyledText
 * inside `` t`...` `` (or `bold(...)` around one) — it stringifies to
 * `[object Object]`; only plain strings and TextChunks compose.
 */
type Chunk = ReturnType<ReturnType<typeof fg>>;

export function toFlatLine(ev: LogEvent, line: string, active: boolean, maxWidth?: number): StyledText {
    const theme = getTheme();
    const color = levelColor(ev.level, theme);
    const chunks: Chunk[] = [];

    // Gutter reservation: always 2 cells (» active, two dim spaces
    // inactive) so rows never shift and the clip budget stays constant.
    if (active) {
        chunks.push(fg(theme.accent)(ACTIVE_CURSOR));
    } else {
        chunks.push(fg(theme.border)("  "));
    }

    // Clip to the available cells BEFORE styling slices the prefix.
    // Without this, long footers / exception-class headers wrap to a second
    // screen row, exceeding the counted `cardLineCount` and letting the
    // hidden native ScrollBox clip the bottom rows including our thumb.
    // Lines view is immune (LogList clips to `lineWidth`); cards need the
    // same 1-logical-line = 1-screen-row invariant here (single choke point).
    let clipped = line;
    if (maxWidth !== undefined) {
        const budget = maxWidth - 2;
        if (budget <= 0) {
            clipped = "";
        } else if (2 + line.length > maxWidth) {
            const prefix = line.slice(0, 2);
            const rest = line.slice(2);
            const room = Math.max(0, budget - prefix.length);
            clipped = prefix + (rest.length > room ? (room <= 1 ? "" : `${rest.slice(0, room - 1)}…`) : rest);
        }
    }

    chunks.push(fg(theme.border)(clipped.slice(0, 2)));

    const text = clipped.slice(2);
    const push = (chunk: Chunk): void => {
        chunks.push(active ? bold(chunk) : chunk);
    };

    if (clipped.startsWith("┌ ")) {
        const level = ev.level.toUpperCase();
        const idx = text.indexOf(level);

        if (idx >= 0) {
            push(fg(theme.dim)(text.slice(0, idx)));
            push(fg(color)(text.slice(idx, idx + level.length)));
            push(fg(theme.dim)(text.slice(idx + level.length)));
        } else {
            push(fg(theme.dim)(text));
        }
    } else if (clipped.startsWith("└ ")) {
        push(fg(theme.dim)(text));
    } else {
        push(fg(theme.text)(text));
    }

    return new StyledText(chunks);
}

/** Flatten events to styled card lines (one entry per screen row; tests + simple paths). */
export function flattenCards(rows: readonly LogEvent[], bodyWidth: number, lineWidth?: number): StyledText[] {
    const out: StyledText[] = [];
    const wrapWidth = lineWidth !== undefined ? effectiveWrapWidth(lineWidth) : undefined;

    for (const ev of rows) {
        for (const line of renderCardWrapped(describeCard(ev, bodyWidth), wrapWidth)) {
            out.push(toFlatLine(ev, line, false, lineWidth));
        }
    }

    return out;
}
