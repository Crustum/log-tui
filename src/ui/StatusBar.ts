import { BoxRenderable, StyledText, TextRenderable, fg } from "@opentui/core";
import { levelColor } from "../format/highlight.js";
import { getTheme } from "../format/theme.js";
import type { TopEntry } from "../store/top.js";
import { detach } from "./detach.js";

export interface StatusBarState {
    follow: boolean;
    hasNew: boolean;
    errorsPerMin: number;
    spark: string;
    dropped: number;
    allCount: number;
    allBadge: number;
    top: TopEntry[];
    filterSummary: string;
    themeName: string;
    /** Connection notice (collector errors, bye, restarts). */
    notice?: string;
    /** Terminal width: every line is hard-truncated to it (overflow wraps and collides). */
    maxWidth: number;
}

/** Footer: counters, errors/min sparkline, top-N, dropped, active filters. */
export class StatusBar {
    private box: BoxRenderable;
    private rowBoxes: TextRenderable[] = [];

    constructor(
        private renderer: any,
        parent: { add: (child: any) => void },
    ) {
        this.box = new BoxRenderable(renderer, {
            id: "status-bar",
            flexDirection: "column",
            width: "100%",
            height: 2,
        } as any);
        parent.add(this.box);
    }

    render(state: StatusBarState): void {
        const theme = getTheme();
        const width = Math.max(20, state.maxWidth);
        const head = [
            `${state.follow ? "FOLLOW" : "SCROLL"}`,
            ...(state.hasNew && !state.follow ? ["↓ new"] : []),
            `err/min ${state.errorsPerMin}${state.spark !== "" ? ` ${state.spark}` : ""}`,
            state.dropped > 0 ? `dropped ${state.dropped}` : "dropped 0",
            `theme:${state.themeName}`,
            `all ${state.allCount}${state.allBadge > 0 ? ` (!${state.allBadge})` : ""}`,
        ];

        const topLine =
            state.top.length > 0
                ? `top: ${state.top.map((e) => `${truncate(e.sample, 40)} ×${e.count}`).join("  ·  ")}`
                : "top: —";

        const lines = [fg(theme.dim)(truncate(head.join("  ·  "), width)), fg(theme.dim)(truncate(topLine, width))];

        if (state.filterSummary !== "") {
            lines.push(fg(theme.accent)(truncate(`filter: ${state.filterSummary}`, width)));
        }

        if (state.notice) {
            lines.push(fg(levelColor("warning", theme))(truncate(state.notice, width)));
        }

        while (this.rowBoxes.length < lines.length) {
            const row = new TextRenderable(this.renderer, {
                id: `status-${this.rowBoxes.length}`,
                width: "100%",
                height: 1,
            } as any);
            this.box.add(row as any);
            this.rowBoxes.push(row);
        }

        this.box.height = lines.length;

        for (const [i, row] of this.rowBoxes.entries()) {
            (row as any).visible = i < lines.length;

            if (i < lines.length) {
                row.content = new StyledText([lines[i] as any]);
            }
        }
    }

    destroy(): void {
        for (const row of this.rowBoxes.splice(0)) {
            (row as any).destroy?.();
        }

        detach((this.box as any).parent, this.box);

        (this.box as any).destroyRecursively?.() ?? (this.box as any).destroy?.();
    }
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
