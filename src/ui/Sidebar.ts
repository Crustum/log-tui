import { BoxRenderable, TextRenderable, bg, bold, fg, t } from "@opentui/core";
import { getTheme } from "../format/theme.js";
import { contrastText, tabColor } from "../format/tabColors.js";
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

/** Sidebar width from tab titles, clamped (multiplex `sidebarWidth` parity). */
export function sidebarWidth(rows: string[]): number {
    const longest = rows.reduce((m, r) => Math.max(m, r.length), 0);

    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, longest + 2));
}

/** Plain-text row (number + title) used for width math and tests. Counts live in the header. */
export function formatSidebarRow(index: number, tab: Tab): string {
    const key = index < 9 ? `${index + 1}` : " ";

    return `${key} ${tab.title}`;
}

export interface SidebarMouseHooks {
    /** A tab row was clicked. */
    onSelect?: (index: number) => void;
    /** The sidebar (but no row) was clicked — takes focus. */
    onPress?: () => void;
}

/** Left tab list: numbers + titles only (counts live in the header). */
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

    render(ui: UiState): void {
        const theme = getTheme();
        const focused = ui.focus === "sidebar";
        this.box.borderColor = focused ? theme.focus : theme.border;
        this.box.backgroundColor = theme.background;
        this.box.width = sidebarWidth(ui.tabs.map((tab, i) => formatSidebarRow(i, tab)));

        while (this.rows.length < ui.tabs.length) {
            const row = new TextRenderable(this.renderer, {
                id: `side-${this.rows.length}`,
                // Never wrap into the next tab's slot (dev-tui parity).
                wrapMode: "none",
            } as any);
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

            const active = i === ui.tabIndex;
            const text = formatSidebarRow(i, tab);
            (row as any).onMouseDown = () => this.hooks.onSelect?.(i);

            // Every stream tab owns one pastel from the shared palette.
            // The selected row fills with it (contrast text on top), idle
            // rows wear it as their label while the number stays chrome.
            const color = tabColor(i, theme.name);
            const head = text.slice(0, 2);
            const label = text.slice(2);

            if (active && color !== null) {
                const onFill = contrastText(color);
                row.content = t`${bg(color)(bold(fg(onFill)(` ${text} `)))}`;

                return;
            }

            if (active) {
                row.content = t`${bg(theme.border)(bold(fg(theme.text)(` ${text} `)))}`;

                return;
            }

            const title = color !== null ? fg(color)(label) : fg(theme.dim)(label);

            row.content = t`${fg(theme.border)(` ${head}`)}${title}`;
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
