import { buildTabs, type Tab } from "./engineTabs.js";
import type { Level, LogConfig, TabDef } from "../protocol.js";

/** Filter editing target. `closed` = not editing. */
export type FilterTarget = "closed" | "global" | "tab";

/** Which pane owns the arrow keys (multiplex parity). */
export type FocusPane = "sidebar" | "content";

/** Log display mode: one row per event, or Phase-1 `CliPrinter` cards. */
export type ViewMode = "lines" | "cards";

/** Layout chrome heights (rows). Mirrors the App root tree. */
export const HEADER_ROWS = 1;
export const STATUS_ROWS = 2;
export const FILTER_CLOSED_ROWS = 1;
export const FILTER_OPEN_ROWS = 4; // framed box: border + label + input + border
export const CHROME_ROWS = 2; // content-box top/bottom borders
export const CONTENT_HEADER_ROWS = 1; // tab title line inside the content box

/**
 * Content viewport for a terminal of `totalRows`. Pure so follow math and
 * layout share one definition — a fixed constant drifted from reality (P2).
 */
export function viewportRows(totalRows: number, filterRows: number, statusRows: number): number {
    return Math.max(3, totalRows - HEADER_ROWS - filterRows - statusRows - CHROME_ROWS - CONTENT_HEADER_ROWS);
}

/** Filter-row height: label + edit widget when open, hint line when closed. */
export function filterRowsFor(mode: FilterTarget): number {
    return mode === "closed" ? FILTER_CLOSED_ROWS : FILTER_OPEN_ROWS;
}

/** Tab/scroll/focus/search UI state. The host owns ALL state — instant re-filter, no round-trip. */
export class UiState {
    /** 0 = All (merged), rest per `tabs` order. */
    tabIndex = 0;
    scrollOffset = 0;
    follow = true;
    filterMode: FilterTarget = "closed";
    /** Global filter: applies to every tab. */
    globalFilter = "";
    /** Per-tab text filters by tab title (engine/custom/source tabs alike). */
    tabFilters = new Map<string, string>();
    helpOpen = false;
    /** Cursor into the current visible rows for n/N navigation. */
    matchIndex = 0;
    /** Arrow-key owner: sidebar tabs or log content. */
    focus: FocusPane = "content";
    /** Log display mode. */
    view: ViewMode = "lines";
    /** Sidebar hidden (`b`): content takes the full width. */
    sidebarHidden = false;
    /** New events arrived while unfollowed (footer `↓ new` badge). */
    hasNew = false;
    /** Minimum severity gate (null = all). Applies to visible rows only —
     * sidebar counts/badges stay tab-only (text-filter precedent). */
    minLevel: Level | null = null;
    /** Current tab list; rebuilt when the server announces configs (Phase 3). */
    tabs: Tab[];

    constructor(
        readonly sources: string[],
        opts: { logConfigs?: LogConfig[]; explicitTabs?: TabDef[] } = {},
    ) {
        this.tabs = buildTabs({ sources, logConfigs: opts.logConfigs, explicitTabs: opts.explicitTabs });
    }

    /**
     * Rebuild tabs from a `ready` announcement (tabs plan §2 order, §7.3
     * precedence). Keeps the selected title when it still exists.
     */
    setServerTabs(logConfigs?: LogConfig[], explicitTabs?: TabDef[]): void {
        const current = this.activeTab.title;
        this.tabs = buildTabs({ sources: this.sources, logConfigs, explicitTabs });
        const kept = this.tabs.findIndex((t) => t.title === current);
        this.tabIndex = kept >= 0 ? kept : 0;
        this.resetView();
    }

    get titles(): string[] {
        return this.tabs.map((t) => t.title);
    }

    get activeTab(): Tab {
        return this.tabs[this.tabIndex] ?? { title: "All", kind: "all" };
    }

    /** Non-null only for raw `source` tabs. */
    get activeSource(): string | null {
        const tab = this.activeTab;

        return tab.kind === "source" ? (tab.source ?? null) : null;
    }

    get filterOpen(): boolean {
        return this.filterMode !== "closed";
    }

    /** Text of the filter currently being edited (or about to be). */
    activeFilterText(): string {
        if (this.filterMode === "tab") {
            return this.tabFilters.get(this.activeTab.title) ?? "";
        }

        return this.globalFilter;
    }

    setActiveFilterText(text: string): void {
        if (this.filterMode === "tab") {
            const title = this.activeTab.title;

            if (text === "") {
                this.tabFilters.delete(title);
            } else {
                this.tabFilters.set(title, text);
            }

            return;
        }

        this.globalFilter = text;
    }

    tabFilterFor(title: string): string {
        return this.tabFilters.get(title) ?? "";
    }

    resetView(): void {
        this.scrollOffset = 0;
        this.follow = true;
        this.hasNew = false;
        this.matchIndex = 0;
    }

    toggleFocus(): void {
        // Hidden sidebar owns no keys: Tab never strands focus on it.
        if (this.sidebarHidden) {
            this.focus = "content";
            return;
        }
        this.focus = this.focus === "sidebar" ? "content" : "sidebar";
    }

    toggleView(total = 0): void {
        this.view = this.view === "lines" ? "cards" : "lines";
        this.scrollOffset = 0;
        this.matchIndex = 0;
        // Staying in follow across a view switch must keep the cursor on
        // the visible tail, not stranded at row 0.
        if (this.follow && total > 0) {
            this.matchIndex = total - 1;
        }
    }

    /** Hide/show the sidebar; hiding pulls focus back to the content. */
    toggleSidebar(): void {
        this.sidebarHidden = !this.sidebarHidden;

        if (this.sidebarHidden && this.focus === "sidebar") {
            this.focus = "content";
        }
    }

    /** Set the severity gate; cursor resets (render clamps the scroll). */
    setMinLevel(level: Level | null): void {
        this.minLevel = level;
        this.matchIndex = 0;
    }

    /** Explicit follow toggle (`s`): on jumps to the bottom, off stays put. */
    toggleFollow(maxOffset: number, total = 0): void {
        if (this.follow) {
            this.follow = false;
        } else {
            this.scrollOffset = maxOffset;
            this.follow = true;
            this.hasNew = false;
            if (total > 0) {
                this.matchIndex = total - 1;
            }
        }
    }

    /** New batch arrived: stick when following, else raise the `↓ new` flag. */
    onIngest(maxOffset: number, total = 0): void {
        if (this.follow) {
            this.scrollOffset = maxOffset;
            if (total > 0) {
                this.matchIndex = total - 1;
            }
        } else {
            this.hasNew = true;
        }
    }

    selectTab(index: number): void {
        this.tabIndex = Math.max(0, Math.min(this.tabs.length - 1, index));
        this.resetView();
    }

    nextTab(): void {
        this.selectTab((this.tabIndex + 1) % this.tabs.length);
    }

    prevTab(): void {
        this.selectTab((this.tabIndex - 1 + this.tabs.length) % this.tabs.length);
    }

    scrollBy(delta: number, maxOffset: number): void {
        this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
        this.follow = this.scrollOffset === maxOffset;
    }

    scrollToTop(): void {
        this.scrollOffset = 0;
        this.follow = false;
        this.matchIndex = 0;
    }

    scrollToBottom(maxOffset: number, total = 0): void {
        this.scrollOffset = maxOffset;
        this.follow = true;
        this.hasNew = false;
        if (total > 0) {
            this.matchIndex = total - 1;
        }
    }

    /**
     * Clamped cursor step for arrows/PgUp/PgDn (no wrap — wrapping on
     * arrows would teleport). Returns the new matchIndex.
     */
    moveCursor(delta: number, total: number): number {
        if (total <= 0) {
            this.matchIndex = 0;
            return 0;
        }

        this.matchIndex = Math.max(0, Math.min(total - 1, this.matchIndex + delta));
        return this.matchIndex;
    }

    /** Anchor the cursor to the last row (G, follow-on, ingest-while-following). */
    anchorToLast(total: number): void {
        this.matchIndex = total > 0 ? total - 1 : 0;
    }

    /**
     * Follow is engaged only when the cursor sits on the last row AND the
     * viewport shows the bottom. Stepping up from the tail unfollows but
     * keeps the viewport; stepping back re-follows.
     */
    syncFollowAfterCursor(maxOffset: number, total: number): void {
        if (total <= 0) {
            this.follow = this.scrollOffset === maxOffset;
            return;
        }

        this.follow = this.matchIndex === total - 1 && this.scrollOffset === maxOffset;
        if (!this.follow && this.scrollOffset !== maxOffset) {
            this.hasNew = this.hasNew || false;
        }
    }

    stickToBottom(maxOffset: number): void {
        if (this.follow) {
            this.scrollOffset = maxOffset;
        }
    }
}
