import { BoxRenderable, TextRenderable, bg, bold, fg, t } from "@opentui/core";
import { getTheme } from "../format/theme.js";
import type { Tab } from "../store/engineTabs.js";
import type { UiState } from "../store/ui.js";
import { detach } from "./detach.js";

export interface SidebarStats {
    /** Rows matching the tab (before text filters). */
    count: number;
    /** Error/warn rows in the tab. */
    badge: number;
    dropped: number;
}

export const SIDEBAR_MIN_WIDTH = 15;
export const SIDEBAR_MAX_WIDTH = 40;

/** Sidebar width from tab titles + badges, clamped (multiplex `sidebarWidth` parity). */
export function sidebarWidth(rows: string[]): number {
    const longest = rows.reduce((m, r) => Math.max(m, r.length), 0);

    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, longest + 2));
}

/** Plain-text row (number + title + counts + badges) used for width math and tests. */
export function formatSidebarRow(index: number, tab: Tab, stats: SidebarStats): string {
    const key = index < 9 ? `${index + 1}` : " ";
    let s = `${key} ${tab.title}(${stats.count})`;

    if (stats.badge > 0) {
        s += ` !${stats.badge}`;
    }

    if (stats.dropped > 0) {
        s += ` ▽${stats.dropped}`;
    }

    return s;
}

export interface SidebarMouseHooks {
    /** A tab row was clicked. */
    onSelect?: (index: number) => void;
    /** The sidebar (but no row) was clicked — takes focus. */
    onPress?: () => void;
}

/** Left tab list (multiplex parity): numbers, counts, `!`/`▽` badges, focus border. */
export class Sidebar {
    private box: BoxRenderable;
    private rows: TextRenderable[] = [];

    constructor(
        private renderer: any,
        private parent: BoxRenderable,
        private hooks: SidebarMouseHooks = {},
    ) {
        this.box = new BoxRenderable(renderer, {
            id: "sidebar",
            flexDirection: "column",
            width: SIDEBAR_MIN_WIDTH,
            flexShrink: 0,
            border: true,
            borderColor: getTheme().border,
            backgroundColor: getTheme().background,
        } as any);
        parent.add(this.box as any);
        (this.box as any).onMouseDown = () => this.hooks.onPress?.();
    }

    setVisible(v: boolean): void {
        (this.box as any).visible = v;
    }

    render(ui: UiState, stats: SidebarStats[]): void {
        const theme = getTheme();
        const focused = ui.focus === "sidebar";
        this.box.borderColor = focused ? theme.focus : theme.border;
        this.box.backgroundColor = theme.background;
        this.box.width = sidebarWidth(ui.tabs.map((tab, i) => formatSidebarRow(i, tab, stats[i] ?? { count: 0, badge: 0, dropped: 0 })));

        while (this.rows.length < ui.tabs.length) {
            const row = new TextRenderable(this.renderer, { id: `side-${this.rows.length}` } as any);
            (this.box as any).add(row as any);
            this.rows.push(row);
        }

        while (this.rows.length > ui.tabs.length) {
            const row = this.rows.pop();
            if (row) {
                detach(this.box, row);
                row.destroy();
            }
        }

        ui.tabs.forEach((tab, i) => {
            const row = this.rows[i];
            if (!row) {
                return;
            }

            const st = stats[i] ?? { count: 0, badge: 0, dropped: 0 };
            const active = i === ui.tabIndex;
            const text = formatSidebarRow(i, tab, st);
            (row as any).onMouseDown = () => this.hooks.onSelect?.(i);

            row.content = active
                ? t`${bg(theme.border)(bold(fg(theme.text)(` ${text} `)))}`
                : st.badge > 0
                  ? t`${fg(theme.border)(` ${text.slice(0, 2)}`)}${fg(theme.accent)(text.slice(2))}`
                  : t`${fg(theme.border)(` ${text.slice(0, 2)}`)}${fg(theme.dim)(text.slice(2))}`;
        });
    }

    destroy(): void {
        for (const row of this.rows.splice(0)) {
            detach(this.box, row);
            row.destroy();
        }

        detach(this.parent, this.box);

        (this.box as any).destroyRecursively?.() ?? (this.box as any).destroy?.();
    }
}
