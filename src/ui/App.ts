import { BoxRenderable, TextRenderable, createCliRenderer, fg, t, createHostClipboard } from "@opentui/core";
import type { HostClipboardService } from "@opentui/core";
import { FakeGenerator, FAKE_LOG_CONFIGS } from "../fake.js";
import { cardBodyWidth } from "./CardList.js";
import { cardStarts } from "../format/cards.js";
import { formatTs } from "../format/highlight.js";
import { getTheme, setTheme, toggleTheme } from "../format/theme.js";
import { isShifted, keyToAction } from "../input/keys.js";
import { Counters, sparkline } from "../store/counters.js";
import { matchesTab, type Tab } from "../store/engineTabs.js";
import { isEmptyFilter, matchesFilter, parseFilter } from "../store/filters.js";
import { meetsMinLevel, nextMinLevel } from "../store/levels.js";
import { QUIT_WINDOW_MS, ctrlCWantsQuit } from "../store/quitGate.js";
import { pickCopyText } from "../store/clipboard.js";
import { LogsStore } from "../store/logs.js";
import { ensureVisible, nextMatch, prevMatch } from "../store/search.js";
import { TopTracker } from "../store/top.js";
import { UiState, filterRowsFor, viewportRows, type ViewMode } from "../store/ui.js";
import type { LogConfig, LogEvent, TabDef } from "../protocol.js";
import type { CollectorClient, ConnectOptions } from "../transport/collector.js";
import { CardList } from "./CardList.js";
import { detach } from "./detach.js";
import { FilterBar } from "./FilterBar.js";
import { FullView, fullMaxScroll } from "./FullView.js";
import { HelpOverlay } from "./HelpOverlay.js";
import { LevelModal } from "./LevelModal.js";
import { LogList } from "./LogList.js";
import { Sidebar, formatSidebarRow, sidebarWidth, type SidebarStats as TabStats } from "./Sidebar.js";
import { StatusBar } from "./StatusBar.js";

export interface AppOptions {
    sources?: string[];
    bufferSize?: number;
    fake?: boolean;
    fakeIntervalMs?: number;
    onEvent?: (event: LogEvent) => void;
    /** Prefill for the global filter (also `--filter` headless). */
    globalFilter?: string;
    /** Server-announced engine configs (Phase 3 `ready`); fake mode uses demo configs. */
    logConfigs?: LogConfig[];
    /** Explicit tab definitions — replace derived defaults (tabs plan §7.3). */
    explicitTabs?: TabDef[];
    theme?: string;
    cwd?: string;
    view?: ViewMode;
    /** Test seam: fixed terminal size (production reads the live stdout). */
    terminal?: { cols: number; rows: number };
}

/** Test seam: inject a renderer (e.g. OpenTUI TestRenderer) instead of creating one. */
export interface AppDeps {
    renderer?: any;
    /** Clipboard writer override (tests). Defaults to host-native → OSC52. */
    writeClipboard?: (text: string) => Promise<boolean>;
}

const SIDEBAR_HINT = "↑↓ tabs · tab logs · 1-9 jump · b sidebar · l level · ? help · q quit";
const CONTENT_HINT = "↑↓ select · tab focus · 1-9 tabs · s follow · v view · b sidebar · l level · Enter full · ? help · q quit";

/** Cursor rides this many rows inside the window edge (not glued to it). */
const CURSOR_MARGIN = 2;

/** Row budgets from the terminal width and sidebar width (single source). */
function widthsFor(cols: number, sideW: number): { bodyWidth: number; lineWidth: number } {
    // Row budget in cells: content-box borders (2) + our thumb column (1).
    return { bodyWidth: cardBodyWidth(cols, sideW), lineWidth: Math.max(20, cols - sideW - 2 - 1) };
}

/** Root layout: header + sidebar/content + FilterBar + StatusBar. Owns ALL state. */
export class App {
    readonly ui: UiState;
    readonly logs: LogsStore;
    readonly counters = new Counters();
    readonly top = new TopTracker();
    private renderer: any;
    private root: BoxRenderable | null = null;
    private header!: TextRenderable;
    private middle!: BoxRenderable;
    private sidebar!: Sidebar;
    private contentBox!: BoxRenderable;
    private contentHeader!: TextRenderable;
    private list!: LogList;
    private cards!: CardList;
    private filterBar!: FilterBar;
    private statusBar!: StatusBar;
    private help!: HelpOverlay;
    private levelModal!: LevelModal;
    private full!: FullView;
    /** Event shown in the full-view modal (null = closed) + its scroll offset. */
    private fullEvent: LogEvent | null = null;
    private fullScroll = 0;
    private fake: FakeGenerator | null = null;
    private collector: CollectorClient | null = null;
    private collectorOptions: ConnectOptions | null = null;
    private notice: string | null = null;
    private keyHandler: ((key: any) => void) | null = null;
    private destroyed = false;
    private cwd: string;
    /** First-Ctrl+C timestamp for the double-press quit gate (null = none). */
    private lastCtrlC: number | null = null;
    /** Theme name at the last render — gates overlay repaints on toggle only. */
    private lastThemeName: string | null = null;
    /** Transient copy toast shown in the hints line (null = none). */
    private copyToast: string | null = null;
    private copyToastTimer: ReturnType<typeof setTimeout> | null = null;
    /** Native clipboard service (lazy) + test-seam writer override. */
    private hostClipboard: HostClipboardService | null = null;
    private injectedWrite: ((text: string) => Promise<boolean>) | null = null;
    /** Opener char to swallow if it echoes into the filter input (see onInput). */
    private filterOpener: string | null = null;

    constructor(options: AppOptions = {}) {
        const sources = options.sources ?? ["cake_live", "cake_file"];
        const logConfigs = options.logConfigs ?? (options.fake !== false ? FAKE_LOG_CONFIGS : undefined);
        this.ui = new UiState(sources, { logConfigs, explicitTabs: options.explicitTabs });
        this.ui.globalFilter = options.globalFilter ?? "";
        this.ui.view = options.view ?? "lines";
        this.logs = new LogsStore(sources, options.bufferSize ?? 10_000);
        this.cwd = options.cwd ?? process.cwd();
        this.fakeOptions = options;

        if (options.theme) {
            setTheme(options.theme);
        }
    }

    private fakeOptions: AppOptions;

    static async create(options: AppOptions = {}, deps: AppDeps = {}): Promise<App> {
        const app = new App(options);
        await app.init(deps);
        return app;
    }

    private async init(deps: AppDeps = {}): Promise<void> {
        // openConsoleOnError: false — the renderer's error console crashes on
        // tiny buffers and masks the primary error. Ours surfaces via cli.ts
        // (message + debug file) instead.
        // exitOnCtrlC: false — the first Ctrl+C copies + toasts, only a
        // double press quits (opencode pattern). The renderer would destroy
        // itself natively on the first press; the App owns the whole gate.
        this.renderer =
            deps.renderer ?? (await createCliRenderer({ exitOnCtrlC: false, openConsoleOnError: false } as any));
        (this.renderer as any).start?.();
        this.injectedWrite = deps.writeClipboard ?? null;

        this.root = new BoxRenderable(this.renderer, {
            id: "app-root",
            flexDirection: "column",
            width: "100%",
            height: "100%",
            backgroundColor: getTheme().background,
        } as any);
        this.renderer.root.add(this.root);

        this.header = new TextRenderable(this.renderer, { id: "app-header", height: 1 } as any);
        (this.root as any).add(this.header as any);

        this.middle = new BoxRenderable(this.renderer, {
            id: "app-middle",
            flexDirection: "row",
            flexGrow: 1,
            width: "100%",
            backgroundColor: getTheme().background,
        } as any);
        (this.root as any).add(this.middle as any);

        this.sidebar = new Sidebar(this.renderer, this.middle, {
            onSelect: (index) => {
                if (this.destroyed) {
                    return;
                }

                this.ui.selectTab(index);
                // Hidden sidebar owns no focus: mouse or not, stay on content.
                this.ui.focus = this.ui.sidebarHidden ? "content" : "sidebar";
                if (this.ui.follow) {
                    const list = this.visibleRows();
                    this.ui.anchorToLast(list.length);
                }
                this.render();
            },
            onPress: () => {
                if (this.destroyed || this.ui.focus === "sidebar" || this.ui.sidebarHidden) {
                    return;
                }

                this.ui.focus = "sidebar";
                this.render();
            },
        });

        this.contentBox = new BoxRenderable(this.renderer, {
            id: "app-content",
            flexDirection: "column",
            flexGrow: 1,
            border: true,
            borderColor: getTheme().focus,
            backgroundColor: getTheme().background,
        } as any);
        (this.middle as any).add(this.contentBox as any);

        this.contentHeader = new TextRenderable(this.renderer, { id: "content-header", height: 1 } as any);
        (this.contentBox as any).add(this.contentHeader as any);

        // Mouse bubbles row → ScrollBox → contentBox, so one box-level pair
        // covers wheel scroll + click-to-focus for the whole content pane.
        (this.contentBox as any).onMouseDown = () => {
            if (this.destroyed || this.ui.focus === "content") {
                return;
            }

            this.ui.focus = "content";
            this.render();
        };
        (this.contentBox as any).onMouse = (e: any) => {
            if (this.destroyed || e?.type !== "scroll") {
                return;
            }

            const dir = e?.scroll?.direction;

            if (dir === "up" || dir === "down") {
                if (this.fullEvent) {
                    this.fullScrollBy(dir === "up" ? -3 : 3);
                    return;
                }

                this.ui.scrollBy(dir === "up" ? -3 : 3, this.maxOffset());
                this.render();
            }
        };
        this.list = new LogList(this.renderer, this.contentBox);
        this.cards = new CardList(this.renderer, this.contentBox);
        this.list.onOpen = (ev, index) => this.openFullFromRow(ev, index);
        this.cards.onOpen = (ev, index) => this.openFullFromRow(ev, index);
        this.cards.setVisible(this.ui.view === "cards");
        this.list.setVisible(this.ui.view !== "cards");

        this.filterBar = new FilterBar(this.renderer, this.root);
        this.filterBar.onInput = (text) => {
            if (this.destroyed || !this.ui.filterOpen) {
                return;
            }

            // The opener keystroke (`/`/`f`) lands in the freshly focused
            // input as an echo of the same keypress — swallow exactly that.
            if (this.filterOpener !== null) {
                const opener = this.filterOpener;
                this.filterOpener = null;

                if (text === opener) {
                    this.filterBar.setValue("");
                    return;
                }
            }

            this.ui.setActiveFilterText(text);
            this.ui.matchIndex = 0;

            const max = this.maxOffset();
            if (this.ui.scrollOffset > max) {
                this.ui.scrollOffset = max;
            }

            this.render();
        };
        this.filterBar.onSubmit = () => {
            if (this.destroyed || !this.ui.filterOpen) {
                return;
            }

            this.dispatch("filter:confirm");
        };

        this.statusBar = new StatusBar(this.renderer, this.root);
        this.help = new HelpOverlay(this.renderer);
        this.levelModal = new LevelModal(this.renderer);
        this.full = new FullView(this.renderer);

        this.keyHandler = (key: any) => this.onKey(key);
        this.renderer.keyInput.on("keypress", this.keyHandler);

        if (this.fakeOptions.fake !== false) {
            this.fake = new FakeGenerator(
                (e) => this.ingest(e),
                this.ui.sources,
                this.fakeOptions.fakeIntervalMs ?? 350,
            );
            this.fake.start();
        }

        this.render();
    }

    /**
     * Attach a live collector. `restart` then restarts the child while host
     * buffers, counters and filters are preserved; `destroy` shuts it down.
     */
    attachCollector(client: CollectorClient, options: ConnectOptions): void {
        this.collector = client;
        this.collectorOptions = options;
    }

    /** Connection notice shown in the footer (null clears it). */
    setNotice(notice: string | null): void {
        this.notice = notice;
        this.render();
    }

    /** Full-view modal open for tests and click hooks. */
    get fullOpen(): boolean {
        return this.fullEvent !== null;
    }

    /** Only one modal at a time: never open one inside another. */
    private anyModalOpen(): boolean {
        return this.fullEvent !== null || this.help.isOpen || this.levelModal.isOpen;
    }

    /** Open the full-view modal for one event (click a line/card row). */
    openFull(ev: LogEvent): void {
        if (this.destroyed) {
            return;
        }

        this.fullEvent = ev;
        this.fullScroll = 0;
        this.render();
    }

    /**
     * Row click: the first click only takes focus (past behavior), the modal
     * opens once the content pane is already active. The cursor syncs to the
     * clicked row first, so Enter/copy act on the same row afterwards.
     * Clicks never stack a modal onto another one.
     */
    private openFullFromRow(ev: LogEvent, index?: number): void {
        if (this.destroyed || this.anyModalOpen()) {
            return;
        }

        if (this.ui.focus !== "content") {
            this.ui.focus = "content";
            if (index !== undefined) {
                this.ui.matchIndex = index;
            }
            this.render();
            return;
        }

        if (index !== undefined) {
            this.ui.matchIndex = index;
        }
        this.openFull(ev);
    }

    /** Close the full-view modal (Esc/`?`/Enter or outside click). */
    closeFull(): void {
        if (this.fullEvent === null) {
            return;
        }

        this.fullEvent = null;
        this.fullScroll = 0;
        this.render();
    }

    /** Scroll inside the open modal, clamped to its own window. */
    fullScrollBy(delta: number): void {
        if (this.fullEvent === null) {
            return;
        }

        const { cols, rows: termRows } = this.termSize();
        const max = fullMaxScroll(this.fullEvent, cols, termRows);
        this.fullScroll = Math.max(0, Math.min(max, this.fullScroll + delta));
        this.render();
    }

    /** Restart the collector child, then rebuild tabs from the fresh `ready`. */
    private async restartCollector(): Promise<void> {
        if (!this.collector || !this.collectorOptions) {
            return;
        }

        try {
            const ready = await this.collector.restart(this.collectorOptions);
            this.ui.setServerTabs(ready.logConfigs, ready.tabs);
            this.setNotice(null);
        } catch (err) {
            this.setNotice(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    ingest(event: LogEvent): void {
        if (this.destroyed) {
            return;
        }

        this.logs.push(event);
        this.counters.record(event);
        this.top.record(event);
        this.fakeOptions.onEvent?.(event);

        // Single visibleRows() fetch: scroll bounds and tail-tracking share it.
        const rows = this.visibleRows();
        this.ui.onIngest(this.maxOffset(rows), rows.length);
        this.render();
    }

    /** Rows for the active tab after the tab matcher + global + tab text filters. */
    visibleRows(): LogEvent[] {
        return this.applyTextFilters(this.tabRows(this.ui.activeTab));
    }

    /** Rows matching the tab definition alone (used for tab badges). */
    tabRows(tab: Tab): LogEvent[] {
        switch (tab.kind) {
            case "all":
                return this.logs.all();
            case "source":
                return [...this.logs.forSource(tab.source ?? "")];
            case "engine":
            case "custom":
                return this.logs.all().filter((e) => matchesTab(e, tab));
        }
    }

    private applyTextFilters(rows: LogEvent[]): LogEvent[] {
        const min = this.ui.minLevel;
        const global = parseFilter(this.ui.globalFilter);
        const tabRaw = this.ui.tabFilterFor(this.ui.activeTab.title);
        const tabExpr = parseFilter(tabRaw);

        if (min === null && isEmptyFilter(global) && isEmptyFilter(tabExpr)) {
            return rows;
        }

        return rows.filter(
            (e) =>
                (min === null || meetsMinLevel(e.level, min)) &&
                (isEmptyFilter(global) || matchesFilter(e, global)) &&
                (isEmptyFilter(tabExpr) || matchesFilter(e, tabExpr)),
        );
    }

    private tabStats(): TabStats[] {
        return this.ui.tabs.map((tab) => {
            const rows = this.tabRows(tab);
            let badge = 0;

            for (const e of rows) {
                if (e.level === "warning" || e.level === "error" || e.level === "critical" || e.level === "alert" || e.level === "emergency") {
                    badge++;
                }
            }

            const dropped = tab.kind === "source" ? this.logs.droppedCount(tab.source ?? "") : this.logs.totalDropped();

            return { count: rows.length, badge, dropped };
        });
    }

    private termSize(): { cols: number; rows: number } {
        const fixed = this.fakeOptions.terminal;

        if (fixed) {
            return { cols: fixed.cols, rows: fixed.rows };
        }

        // The renderer owns the real window size: stdout.columns can report
        // the (wider) console buffer on Windows, which made the footer
        // truncate too late and wrap mid-word over the content above it.
        const width = (this.renderer as any)?.width;
        const height = (this.renderer as any)?.height;

        return {
            cols: typeof width === "number" && width > 0 ? width : (process.stdout.columns ?? 80),
            rows: typeof height === "number" && height > 0 ? height : (process.stdout.rows ?? 24),
        };
    }

    private filterSummary(): string {
        const bits: string[] = [];

        if (this.ui.minLevel !== null) {
            bits.push(`lvl:${this.ui.minLevel}+`);
        }

        if (this.ui.globalFilter.trim() !== "") {
            bits.push(`global \`${this.ui.globalFilter}\``);
        }

        const tabFilter = this.ui.tabFilterFor(this.ui.activeTab.title);

        if (tabFilter.trim() !== "") {
            bits.push(`tab(${this.ui.activeTab.title}) \`${tabFilter}\``);
        }

        return bits.join("  ");
    }

    private statusRows(): number {
        return 2 + (this.filterSummary() !== "" ? 1 : 0) + (this.notice ? 1 : 0);
    }

    /** Content viewport shared by scroll, follow and both list views (P2 fix). */
    viewport(): number {
        return viewportRows(this.termSize().rows, filterRowsFor(this.ui.filterMode), this.statusRows());
    }

    /**
     * Row budgets shared by scroll math and card rendering: wrapped cards
     * occupy wrapped screen rows, so counting and emission must use the same
     * widths or the scrollbar drifts.
     */
    private cardWidths(): { bodyWidth: number; lineWidth: number } {
        const { cols } = this.termSize();
        const sideW = this.sidebarWidth(this.tabStats());

        return widthsFor(cols, sideW);
    }

    /** Scrollable length in the active view (events for lines, screen rows for cards). */
    private contentLength(rows?: LogEvent[]): number {
        if (this.ui.view === "cards") {
            const { bodyWidth, lineWidth } = this.cardWidths();
            return cardStarts(rows ?? this.visibleRows(), bodyWidth, lineWidth).total;
        }

        return (rows ?? this.visibleRows()).length;
    }

    private maxOffset(rows?: LogEvent[]): number {
        return Math.max(0, this.contentLength(rows) - this.viewport());
    }

    /** Match cursor as a line offset (card view maps the event cursor to its header line). */
    private cursorLine(rows: LogEvent[]): number {
        if (this.ui.view !== "cards") {
            return this.ui.matchIndex;
        }

        const { bodyWidth, lineWidth } = this.cardWidths();
        const { starts } = cardStarts(rows, bodyWidth, lineWidth);

        return starts[Math.min(this.ui.matchIndex, Math.max(0, rows.length - 1))] ?? 0;
    }

    /** Event index containing a screen line (cards view; lines view is identity). */
    private eventIndexAtScreenLine(rows: LogEvent[], screenLine: number): number {
        if (this.ui.view !== "cards") {
            return Math.max(0, Math.min(rows.length - 1, screenLine));
        }

        const { bodyWidth, lineWidth } = this.cardWidths();
        const { starts } = cardStarts(rows, bodyWidth, lineWidth);
        let idx = 0;

        for (let i = 0; i < starts.length; i++) {
            if ((starts[i] ?? 0) <= screenLine) {
                idx = i;
            } else {
                break;
            }
        }

        return Math.max(0, Math.min(rows.length - 1, idx));
    }

    /** Move the cursor by delta and reveal it with margin; updates follow. */
    private moveCursorAndReveal(list: LogEvent[], delta: number): void {
        if (list.length <= 0) {
            return;
        }

        const vp = this.viewport();
        const max = this.maxOffset(list);
        this.ui.moveCursor(delta, list.length);
        this.ui.scrollOffset = ensureVisible(this.cursorLine(list), this.ui.scrollOffset, vp, max, CURSOR_MARGIN);
        this.ui.syncFollowAfterCursor(max, list.length);
    }

    private sidebarWidth(stats: TabStats[]): number {
        if (this.ui.sidebarHidden) {
            return 0;
        }

        return sidebarWidth(
            this.ui.tabs.map((tab, i) => formatSidebarRow(i, tab, stats[i] ?? { count: 0, badge: 0, dropped: 0 })),
        );
    }

    private onKey(key: any): void {
        if (this.destroyed) {
            return;
        }

        // Help overlay takes Esc/? first.
        if (this.help.isOpen && (key.name === "escape" || key.sequence === "?" || key.name === "?")) {
            this.help.close();
            this.render();
            return;
        }

        // Full-view modal hijacks content keys (filterOpen precedent): arrows
        // and wheel scroll inside, Esc/?/Enter closes, printables are
        // swallowed so they never leak into filters. Quit still quits.
        if (this.fullEvent !== null) {
            if (key.name === "escape" || key.sequence === "?" || key.name === "?" || key.name === "return" || key.name === "enter") {
                this.closeFull();
                return;
            }

            if (key.name === "up" || key.name === "k") {
                this.fullScrollBy(-1);
                return;
            }

            if (key.name === "down" || key.name === "j") {
                this.fullScrollBy(1);
                return;
            }

            if (key.name === "pageup") {
                this.fullScrollBy(-this.viewport());
                return;
            }

            if (key.name === "pagedown") {
                this.fullScrollBy(this.viewport());
                return;
            }

            if (isShifted(key, "G") || key.name === "end") {
                this.fullScrollBy(Number.POSITIVE_INFINITY);
                return;
            }

            if (key.name === "g" || key.name === "home") {
                this.fullScrollBy(Number.NEGATIVE_INFINITY);
                return;
            }

            if (key.ctrl && key.name === "c") {
                this.dispatch("quit:press");
                return;
            }

            if (key.name === "q") {
                this.dispatch("quit");
                return;
            }

            return;
        }

        // Level modal hijacks content keys (filterOpen precedent): arrows
        // move, Enter confirms, Esc cancels, printables are swallowed so they
        // never leak into filters. Quit still quits.
        if (this.levelModal.isOpen) {
            if (key.name === "escape") {
                this.levelModal.close();
                this.render();
                return;
            }

            if (key.name === "return" || key.name === "enter") {
                this.ui.setMinLevel(this.levelModal.selected);
                this.levelModal.close();
                this.render();
                return;
            }

            if (key.name === "up" || key.name === "k") {
                this.levelModal.move(-1);
                this.render();
                return;
            }

            if (key.name === "down" || key.name === "j") {
                this.levelModal.move(1);
                this.render();
                return;
            }

            if (key.ctrl && key.name === "c") {
                this.dispatch("quit:press");
                return;
            }

            if (key.name === "q") {
                this.dispatch("quit");
                return;
            }

            return;
        }

        // Filter editing: the InputRenderable consumes printable keys natively
        // (cursor, backspace, paste). The host only handles confirm/cancel —
        // everything else is ignored so typing never double-inserts or quits.
        if (this.ui.filterOpen) {
            if (key.name === "escape") {
                this.dispatch("filter:cancel");
                return;
            }

            if (key.name === "return" || key.name === "enter") {
                this.dispatch("filter:confirm");
                return;
            }

            if (key.ctrl && key.name === "c") {
                this.dispatch("quit:press");
                return;
            }

            if (key.name === "q") {
                this.dispatch("quit");
                return;
            }

            return;
        }

        // Enter on a content row opens the full-view modal for the active row.
        // Never inside another modal.
        if (
            (key.name === "return" || key.name === "enter") &&
            this.ui.focus === "content" &&
            !this.help.isOpen &&
            !this.levelModal.isOpen
        ) {
            const rows = this.visibleRows();
            const ev = rows[Math.min(this.ui.matchIndex, Math.max(0, rows.length - 1))];

            if (ev !== undefined) {
                this.openFull(ev);
            }

            return;
        }

        const action = keyToAction(key, false);

        if (action) {
            this.dispatch(action);
        }
    }

    private dispatch(action: ReturnType<typeof keyToAction>): void {
        if (!action) {
            return;
        }

        const rows = () => this.visibleRows();
        const maxOffset = (list?: LogEvent[]) => this.maxOffset(list ?? rows());
        const vp = () => this.viewport();

        const anchorTabSwitch = (): void => {
            // selectTab/resetView leaves offset 0 with follow=true; the
            // render pins the viewport to the tail, so the cursor belongs
            // there too — otherwise Enter opens row 0 while looking at tail.
            if (this.ui.follow) {
                const list = rows();
                this.ui.anchorToLast(list.length);
            }
        };

        switch (action) {
            case "quit":
                void this.destroy().then(() => process.exit(0));
                return;
            case "quit:press": {
                // Double Ctrl+C gate: second press inside the window quits,
                // the first copies the visible rows and toasts instead.
                const now = Date.now();

                if (ctrlCWantsQuit(this.lastCtrlC, now)) {
                    this.lastCtrlC = null;
                    this.clearCopyToast();
                    void this.destroy().then(() => process.exit(0));
                    return;
                }

                this.lastCtrlC = now;
                this.copyVisibleToClipboard();
                break;
            }
            case "help": {
                if (this.levelModal.isOpen || this.fullEvent !== null) {
                    break;
                }

                const { cols, rows: termRows } = this.termSize();
                this.help.toggle(cols, termRows, () => this.render());
                break;
            }
            case "focus:toggle":
                this.ui.toggleFocus();
                break;
            case "sidebar:toggle":
                this.ui.toggleSidebar();
                break;
            case "follow:toggle": {
                const list = rows();
                this.ui.toggleFollow(maxOffset(list), list.length);
                break;
            }
            case "view:toggle": {
                const list = rows();
                this.ui.toggleView(list.length);
                break;
            }
            case "tab:next":
                this.ui.nextTab();
                anchorTabSwitch();
                break;
            case "tab:prev":
                this.ui.prevTab();
                anchorTabSwitch();
                break;
            case "scroll:up":
                if (this.ui.focus === "sidebar" && !this.ui.sidebarHidden) {
                    this.ui.prevTab();
                    anchorTabSwitch();
                } else {
                    this.moveCursorAndReveal(rows(), -1);
                }
                break;
            case "scroll:down":
                if (this.ui.focus === "sidebar" && !this.ui.sidebarHidden) {
                    this.ui.nextTab();
                    anchorTabSwitch();
                } else {
                    this.moveCursorAndReveal(rows(), 1);
                }
                break;
            case "scroll:pageup":
                if (this.ui.focus === "content") {
                    this.moveCursorAndReveal(rows(), -vp());
                }
                break;
            case "scroll:pagedown":
                if (this.ui.focus === "content") {
                    this.moveCursorAndReveal(rows(), vp());
                }
                break;
            case "scroll:top":
                if (this.ui.focus === "content") {
                    this.ui.scrollToTop();
                }
                break;
            case "scroll:bottom": {
                const list = rows();
                this.ui.scrollToBottom(maxOffset(list), list.length);
                break;
            }
            case "filter:open":
                this.ui.filterMode = "global";
                this.filterOpener = "/";
                break;
            case "filter:open-tab":
                this.ui.filterMode = "tab";
                this.filterOpener = "f";
                break;
            case "filter:confirm": {
                const wasFollow = this.ui.follow;
                this.ui.filterMode = "closed";
                this.filterOpener = null;
                const list = rows();
                const max = maxOffset(list);
                this.ui.scrollOffset = Math.min(this.ui.scrollOffset, max);
                this.ui.matchIndex = 0;
                if (wasFollow) {
                    this.ui.scrollOffset = max;
                    this.ui.anchorToLast(list.length);
                }
                break;
            }
            case "filter:cancel": {
                // Esc clears the filter being edited.
                const wasFollow = this.ui.follow;
                this.ui.setActiveFilterText("");
                this.ui.filterMode = "closed";
                this.filterOpener = null;
                const list = rows();
                const max = maxOffset(list);
                this.ui.scrollOffset = Math.min(this.ui.scrollOffset, max);
                this.ui.matchIndex = 0;
                if (wasFollow) {
                    this.ui.scrollOffset = max;
                    this.ui.anchorToLast(list.length);
                }
                break;
            }
            case "level:open": {
                if (this.help.isOpen || this.fullEvent !== null) {
                    break;
                }

                const { cols, rows: termRows } = this.termSize();
                this.levelModal.open(this.ui.minLevel, cols, termRows, () => this.render());
                break;
            }
            case "level:rotate": {
                const wasFollow = this.ui.follow;
                this.ui.setMinLevel(nextMinLevel(this.ui.minLevel));
                if (wasFollow) {
                    const list = rows();
                    this.ui.scrollOffset = maxOffset(list);
                    this.ui.anchorToLast(list.length);
                }
                break;
            }
            case "match:next":
            case "match:prev": {
                const list = rows();
                const total = list.length;
                if (total <= 0) {
                    break;
                }
                const forward = action === "match:next";
                // Unfollow without moving: stay looking at the tail, the
                // cursor lands in view instead of yanking the viewport.
                if (this.ui.follow) {
                    this.ui.follow = false;
                }
                const off = this.ui.scrollOffset;
                const viewport = vp();
                const max = maxOffset(list);
                const cursorScreen = this.cursorLine(list);
                const visible = cursorScreen >= off && cursorScreen < off + viewport;
                if (!visible) {
                    // Snap-into-view, then step: stale cursor outside the
                    // window jumps to the window edge in the direction of
                    // travel, so wrap only fires at true list ends.
                    const edgeScreen = forward ? off : off + viewport - 1;
                    this.ui.matchIndex = this.eventIndexAtScreenLine(list, edgeScreen);
                }
                this.ui.matchIndex = forward
                    ? nextMatch(this.ui.matchIndex, total)
                    : prevMatch(this.ui.matchIndex, total);
                this.ui.scrollOffset = ensureVisible(
                    this.cursorLine(list),
                    this.ui.scrollOffset,
                    viewport,
                    max,
                    CURSOR_MARGIN,
                );
                this.ui.syncFollowAfterCursor(max, total);
                break;
            }
            case "clear": {
                const tab = this.ui.activeTab;

                if (tab.kind === "source") {
                    this.logs.clear(tab.source);
                    this.counters.clear(tab.source);
                    this.top.clear(tab.source);
                } else if (tab.kind === "all") {
                    this.logs.clear();
                    this.counters.clear();
                    this.top.clear();
                } else {
                    // Engine/custom tabs span sources — remove matching rows.
                    const victims = new Set(this.tabRows(tab));
                    const removed = this.logs.removeWhere((e) => victims.has(e));

                    if (removed > 0) {
                        this.rebuildAggregates();
                    }
                }

                this.ui.scrollOffset = 0;
                this.ui.matchIndex = 0;
                this.ui.hasNew = false;
                break;
            }
            case "restart":
                if (this.collector) {
                    void this.restartCollector();
                } else {
                    this.fake?.restart();
                }
                break;
            case "theme:toggle":
                toggleTheme();
                break;
            default: {
                // tab:N
                const m = action.match(/^tab:(\d)$/);
                if (m) {
                    const n = Number(m[1]);
                    // 1 = first tab, 2.. = rest.
                    this.ui.selectTab(n - 1);
                    anchorTabSwitch();
                }
                break;
            }
        }

        this.render();
    }

    /** Rebuild counters/top after selective removal (clear on engine/custom tabs). */
    private rebuildAggregates(): void {
        this.counters.clear();
        this.top.clear();

        for (const e of this.logs.all()) {
            this.counters.record(e);
            this.top.record(e);
        }
    }

    /**
     * First Ctrl+C: copy the mouse selection when one exists, else the active
     * row, then toast in the hints line. Never throws and never writes OSC52
     * to terminals without support (the raw sequence leaks onto the screen).
     */
    private copyVisibleToClipboard(): void {
        const rows = this.visibleRows();
        const ev = rows[Math.min(this.ui.matchIndex, Math.max(0, rows.length - 1))];
        const activeText =
            ev !== undefined ? `${formatTs(ev.ts)} ${ev.level.toUpperCase().padEnd(9, " ")} ${ev.msg}` : null;
        const picked = pickCopyText(this.renderer, activeText);

        if (!picked) {
            this.showCopyToast("nothing to copy · Ctrl+C again to quit");
            return;
        }

        void this.writeClipboard(picked.text).then((ok) => {
            if (this.destroyed) {
                return;
            }

            this.showCopyToast(
                ok ? `copied ${picked.label} · Ctrl+C again to quit` : "copy unavailable · Ctrl+C again to quit",
            );

            try {
                (this.renderer as any).clearSelection?.();
            } catch {
                // Selection highlight is cosmetic; copy already landed.
            }

            this.render();
        });
    }

    /**
     * Clipboard write: injected seam (tests) → host-native service (what
     * opencode uses; Win32 API on Windows) → OSC52 when supported.
     */
    private async writeClipboard(text: string): Promise<boolean> {
        if (this.injectedWrite) {
            try {
                return await this.injectedWrite(text);
            } catch {
                return false;
            }
        }

        try {
            this.hostClipboard ??= createHostClipboard();
            const res = await this.hostClipboard.writeText(text, {
                selection: "clipboard",
                signal: AbortSignal.timeout(1500),
            });

            if (res.status === "written") {
                return true;
            }
        } catch {
            // Fall through to OSC52.
        }

        try {
            if ((this.renderer as any).isOsc52Supported?.() === false) {
                return false;
            }

            return (this.renderer as any).copyToClipboardOSC52?.(text) === true;
        } catch {
            return false;
        }
    }

    private showCopyToast(text: string): void {
        this.clearCopyToast();
        this.copyToast = text;
        this.copyToastTimer = setTimeout(() => {
            this.copyToast = null;
            this.copyToastTimer = null;
            this.render();
        }, QUIT_WINDOW_MS);
        (this.copyToastTimer as any)?.unref?.();
    }

    private clearCopyToast(): void {
        if (this.copyToastTimer !== null) {
            clearTimeout(this.copyToastTimer);
            this.copyToastTimer = null;
        }

        this.copyToast = null;
    }

    render(): void {
        if (this.destroyed || !this.root) {
            return;
        }

        const { cols, rows: termRows } = this.termSize();
        void termRows;
        const rows = this.visibleRows();
        const now = Date.now() / 1000;
        const tab = this.ui.activeTab;
        const vp = this.viewport();
        const max = this.maxOffset(rows);

        // FOLLOW means bottom: resetView()/selectTab()/clear() leave offset 0
        // with follow=true, which showed the head + top thumb until the next
        // ingest. Pin here so every render honors the invariant, not just ingest.
        if (this.ui.follow) {
            this.ui.scrollOffset = max;
        } else if (this.ui.scrollOffset > max) {
            this.ui.scrollOffset = max;
        }

        // Hidden sidebar owns no focus: normalize any stray sidebar focus
        // (Tab before hiding, mouse hooks) so the content keeps its border.
        if (this.ui.sidebarHidden && this.ui.focus === "sidebar") {
            this.ui.focus = "content";
        }

        if (this.ui.matchIndex >= Math.max(1, rows.length)) {
            this.ui.matchIndex = Math.max(0, rows.length - 1);
        }

        const stats = this.tabStats();
        const sideW = this.sidebarWidth(stats);
        const theme = getTheme();

        // Re-apply every frame: init-time backgrounds go stale on theme:toggle.
        this.root.backgroundColor = theme.background;
        this.middle.backgroundColor = theme.background;
        this.contentBox.backgroundColor = theme.background;

        this.header.content = t`${fg(theme.text)(`cake logs tui · ${this.cwd}`)}`;
        this.sidebar.setVisible(!this.ui.sidebarHidden);
        this.sidebar.render(this.ui, stats);

        const focusedContent = this.ui.focus === "content";
        this.contentBox.borderColor = focusedContent ? theme.focus : theme.border;

        const tabFilter = this.ui.tabFilterFor(tab.title);
        this.contentHeader.content = t`${fg(theme.dim)(`${tab.title} · ${rows.length} events · ${this.ui.view}${tabFilter ? ` · filter: ${tabFilter}` : ""}`)}`;

        const isCards = this.ui.view === "cards";
        this.list.setVisible(!isCards);
        this.cards.setVisible(isCards);

        // Row budget in cells: content-box borders (2) + our thumb column (1).
        // Lines view clips to it; cards wrap to it — both counted the same
        // way via widthsFor, so scroll/follow/thumb math holds.
        const { bodyWidth, lineWidth } = widthsFor(cols, sideW);

        if (isCards) {
            this.cards.render(
                rows,
                this.ui.scrollOffset,
                vp,
                this.cursorLine(rows),
                bodyWidth,
                lineWidth,
            );
        } else {
            this.list.render(rows, this.ui.scrollOffset, vp, this.ui.matchIndex, lineWidth);
        }

        this.filterBar.render({
            mode: this.ui.filterMode,
            globalText: this.ui.globalFilter,
            tabTitle: tab.title,
            tabText: this.ui.tabFilterFor(tab.title),
            focusHint: this.ui.focus === "sidebar" ? SIDEBAR_HINT : CONTENT_HINT,
            toast: this.copyToast ?? undefined,
        });

        this.statusBar.render({
            follow: this.ui.follow,
            hasNew: this.ui.hasNew,
            errorsPerMin: this.counters.errorsPerMinute(now),
            spark: sparkline(this.counters.errorsSparkline(now)),
            dropped: this.logs.totalDropped(),
            allCount: this.logs.all().length,
            allBadge: this.ui.sources.reduce((n, s) => n + this.counters.errorWarnCount(s), 0),
            top: this.top.top(3, this.ui.activeSource ?? undefined),
            filterSummary: this.filterSummary(),
            themeName: getTheme().name,
            notice: this.notice ?? undefined,
            maxWidth: cols,
        });

        if (this.fullEvent !== null) {
            const maxFull = fullMaxScroll(this.fullEvent, cols, termRows);
            this.fullScroll = Math.max(0, Math.min(maxFull, this.fullScroll));

            if (this.full.isOpen) {
                this.full.paint(this.fullEvent, this.fullScroll, cols, termRows);
            } else {
                this.full.open(this.fullEvent, this.fullScroll, cols, termRows, {
                    onClose: () => this.closeFull(),
                    onScroll: (d) => this.fullScrollBy(d),
                });
            }
        } else if (this.full.isOpen) {
            this.full.close();
        }

        // Overlays paint on open only: rebuild their rows when the theme
        // flipped (FullView repaints every frame already). Gated so normal
        // renders never pay for row rebuilds.
        const themeName = getTheme().name;

        if (themeName !== this.lastThemeName) {
            this.lastThemeName = themeName;

            if (this.help.isOpen) {
                this.help.repaint();
            }

            if (this.levelModal.isOpen) {
                this.levelModal.repaint();
            }
        }
    }

    async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.clearCopyToast();

        try {
            await this.hostClipboard?.dispose();
        } catch {
            // Clipboard teardown must not block shutdown.
        }

        this.hostClipboard = null;
        this.fake?.stop();

        // Stop the child first: no more ingest while the UI tears down.
        // Idempotent — a graceful exit already done stays done.
        if (this.collector) {
            try {
                await this.collector.shutdown();
            } catch {
                this.collector.kill();
            }

            this.collector = null;
        }

        if (this.keyHandler) {
            this.renderer.keyInput.off("keypress", this.keyHandler);
            this.keyHandler = null;
        }

        this.help.destroy();
        this.levelModal.destroy();
        this.full.destroy();
        this.sidebar.destroy();
        this.list.destroy();
        this.cards.destroy();
        this.filterBar.destroy();
        this.statusBar.destroy();

        if (this.root) {
            detach(this.renderer.root, this.root);

            (this.root as any).destroyRecursively?.() ?? (this.root as any).destroy?.();
            this.root = null;
        }

        await this.renderer.destroy?.();
    }
}
