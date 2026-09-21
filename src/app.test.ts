import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { LogEvent } from "./protocol.js";
import { App } from "./ui/App.js";

let setup: TestRendererSetup | null = null;
let app: App | null = null;

afterEach(async () => {
    if (app) {
        await app.destroy();
        app = null;
    }

    setup?.renderer.destroy();
    setup = null;
});

function ev(n: number, scope: string, source = "cake_live"): LogEvent {
    return {
        v: 1,
        t: "event",
        source,
        ts: 1726844800 + n,
        level: n % 5 === 0 ? "error" : "info",
        msg: `message ${n} from ${scope}`,
        raw: `message ${n} from ${scope}`,
        meta: { scope },
    };
}

async function boot(
    extraDeps: Record<string, unknown> = {},
): Promise<{ setup: TestRendererSetup; app: App }> {
    // exitOnCtrlC: false mirrors production (App owns the double-press gate;
    // the renderer must not destroy itself natively on the first press).
    const fresh = await createTestRenderer({
        width: 100,
        height: 30,
        useThread: false,
        maxFps: Number.POSITIVE_INFINITY,
        exitOnCtrlC: false,
    } as any);
    setup = fresh;
    const created = await App.create(
        {
            fake: false,
            sources: ["cake_live", "cake_file"],
            terminal: { cols: 100, rows: 30 },
            logConfigs: [{ name: "payments", file: "payments.log", scopes: ["payments"], levels: null }],
        },
        { renderer: fresh.renderer, ...extraDeps },
    );
    app = created;

    for (let i = 0; i < 40; i++) {
        created.ingest(ev(i, i % 2 === 0 ? "payments" : "other"));
    }

    await fresh.flush();

    return { setup: fresh, app: created };
}

describe("app integration (TestRenderer)", () => {
    test("boots with sidebar, content, filter hint and status", async () => {
        const { setup } = await boot();
        const frame = setup.captureCharFrame();

        expect(frame).toContain("All(");
        expect(frame).toContain("payments(");
        // Follow shows the tail, not the head.
        expect(frame).toContain("message 39 from other");
        expect(frame).not.toContain("message 0 from payments");
        expect(frame).toContain("FOLLOW");
        expect(frame).toContain("/ global · f tab");
    });

    test("digit key switches tabs and refreshes content", async () => {
        const { setup, app } = await boot();

        await setup.mockInput.pressKeys(["2"]);
        await setup.flush();

        expect(app.ui.tabIndex).toBe(1);
        expect(app.ui.activeTab.title).toBe("payments");
        const frame = setup.captureCharFrame();
        expect(frame).toContain("payments · 20 events");
        expect(frame).not.toContain("message 1 from other");
    });

    test("slash opens the filter edit widget and typing filters", async () => {
        const { setup, app } = await boot();

        await setup.mockInput.pressKeys(["/"]);
        await setup.flush();

        expect(app.ui.filterOpen).toBe(true);
        let frame = setup.captureCharFrame();
        expect(frame).toContain("/ global:");

        await setup.mockInput.pressKeys(["m", "e", "s", "s", "a", "g", "e", " ", "1"]);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain("message 1");
        expect(app.ui.globalFilter).toBe("message 1");

        await setup.mockInput.pressEscape();
        await setup.flush();
        expect(app.ui.filterOpen).toBe(false);
    });

    test("s toggles follow, v toggles card view", async () => {
        const { setup, app } = await boot();

        await setup.mockInput.pressKeys(["s"]);
        await setup.flush();
        expect(app.ui.follow).toBe(false);
        expect(setup.captureCharFrame()).toContain("SCROLL");

        await setup.mockInput.pressKeys(["v"]);
        await setup.flush();
        expect(app.ui.view).toBe("cards");
        const cards = setup.captureCharFrame();
        expect(cards).toContain("┌");
        expect(cards).not.toContain("[object Object]");
    });

    test("tab key toggles sidebar/content focus", async () => {
        const { setup, app } = await boot();

        expect(app.ui.focus).toBe("content");
        await setup.mockInput.pressTab();
        await setup.flush();
        expect(app.ui.focus).toBe("sidebar");
    });

    test("mouse click on a sidebar row selects that tab", async () => {
        const { setup, app } = await boot();

        // Header row 0, sidebar border row 1, tab rows start at row 2.
        await setup.mockMouse.click(5, 3);
        await setup.flush();

        expect(app.ui.tabIndex).toBe(1);
        expect(app.ui.activeTab.title).toBe("payments");
        expect(app.ui.focus).toBe("sidebar");
    });

    test("mouse wheel over content scrolls and unfollows", async () => {
        const { setup, app } = await boot();

        expect(app.ui.follow).toBe(true);
        await setup.mockMouse.scroll(60, 10, "up");
        await setup.flush();

        expect(app.ui.follow).toBe(false);
        expect(app.ui.scrollOffset).toBeGreaterThanOrEqual(0);
    });

    test("scrollbar thumb tracks the scroll position", async () => {
        const { setup, app } = await boot();
        const max = app.ui.scrollOffset;

        expect(max).toBeGreaterThan(0);
        // At the bottom (follow), the thumb sits on the last visible rows.
        expect(setup.captureCharFrame()).toContain("┃");

        // Arrows drive the cursor: stepping up from the tail unfollows but
        // keeps the viewport (margin 2 absorbs the first steps).
        const total = app.visibleRows().length;
        expect(app.ui.matchIndex).toBe(total - 1);
        await setup.mockInput.pressArrow("up");
        await setup.flush();
        expect(app.ui.matchIndex).toBe(total - 2);
        expect(app.ui.follow).toBe(false);
        expect(app.ui.scrollOffset).toBe(max);
        expect(setup.captureCharFrame()).toContain("┃");
    });

    test("switching tabs while following stays on the tail", async () => {
        const { setup, app } = await boot();

        // Grow the payments tab past the viewport, then switch to it:
        // selectTab resets offset 0 with follow=true (no ingest follows).
        for (let i = 40; i < 80; i++) {
            app.ingest(ev(i, "payments"));
        }

        app.ui.selectTab(1);
        expect(app.ui.activeTab.title).toBe("payments");
        app.render();
        await setup.flush();

        const max = app.visibleRows().length - app.viewport();
        expect(max).toBeGreaterThan(0);
        expect(app.ui.follow).toBe(true);
        expect(app.ui.scrollOffset).toBe(max);

        const frame = setup.captureCharFrame();
        expect(frame).toContain("message 79 from payments");
        expect(frame).not.toContain("message 0 from payments");
    });

    test("footer head and top render on separate rows", async () => {
        const { setup } = await boot();
        const rows = setup.captureCharFrame().split("\n");
        const head = rows.findIndex((r) => r.includes("err/min"));
        const top = rows.findIndex((r) => r.includes("top:"));

        expect(head).toBeGreaterThanOrEqual(0);
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top).not.toBe(head);
    });

    test("footer shows All counters, not per-source internals", async () => {
        // No `terminal` seam: production reads the live size. The renderer
        // owns the true window width; stdout.columns can report a wider
        // Windows console buffer, which wrapped the footer mid-word.
        const fresh = await createTestRenderer({ width: 100, height: 30, useThread: false, maxFps: Number.POSITIVE_INFINITY });

        try {
            const created = await App.create(
                {
                    fake: false,
                    sources: ["cake_live", "cake_file"],
                    logConfigs: [{ name: "payments", file: "payments.log", scopes: ["payments"], levels: null }],
                },
                { renderer: fresh.renderer },
            );

            for (let i = 0; i < 40; i++) {
                created.ingest(ev(i, i % 2 === 0 ? "payments" : "other"));
            }

            await fresh.flush();
            const frame = fresh.captureCharFrame();
            expect(frame).toContain("all 40 (!8)");
            expect(frame).not.toContain("cake_live:");
            expect(frame).not.toContain("cake_file:");
            await created.destroy();
        } finally {
            fresh.renderer.destroy();
        }
    });

    test("long rows are clipped: no wrapped continuation, no native scrollbar", async () => {
        const fresh = await createTestRenderer({ width: 100, height: 30, useThread: false, maxFps: Number.POSITIVE_INFINITY });
        let created: App | null = null;

        try {
            created = await App.create(
                {
                    fake: false,
                    sources: ["cake_live", "cake_file"],
                    terminal: { cols: 100, rows: 30 },
                    logConfigs: [{ name: "queries", file: "queries.log", scopes: null, levels: null }],
                },
                { renderer: fresh.renderer },
            );

            for (let i = 0; i < 200; i++) {
                created.ingest({
                    v: 1,
                    t: "event",
                    source: "cake_file",
                    ts: 1726844800 + i,
                    level: "debug",
                    msg: `SELECT * FROM notifications WHERE foreign_key = '8c7d9503' AND padding ${"x".repeat(120)} ${i}`,
                    raw: `row ${i}`,
                    meta: { file: "queries.log" },
                });
            }

            await fresh.flush();
            const frame = fresh.captureCharFrame();

            expect(frame).not.toContain("▀");
            expect(frame).toContain("…");
            expect(frame).not.toContain("x".repeat(120));
        } finally {
            await created?.destroy();
            fresh.renderer.destroy();
        }
    });

    test("lines drop the log column; cards keep the file/engine header", async () => {
        const fresh = await createTestRenderer({ width: 100, height: 30, useThread: false, maxFps: Number.POSITIVE_INFINITY });
        let created: App | null = null;

        try {
            created = await App.create(
                {
                    fake: false,
                    sources: ["cake_live", "cake_file"],
                    terminal: { cols: 100, rows: 30 },
                    logConfigs: [{ name: "queries", file: "queries.log", scopes: null, levels: null }],
                },
                { renderer: fresh.renderer },
            );

            created.ingest({
                v: 1,
                t: "event",
                source: "cake_live",
                ts: 1726844800,
                level: "debug",
                msg: "connection=default role=write duration=3.7 rows=1",
                raw: "raw 0",
                meta: { scopes: ["queriesLog", "cake.database.queries"], engine: "queries", file: "queries.log" },
            });
            created.ingest({
                v: 1,
                t: "event",
                source: "cake_live",
                ts: 1726844801,
                level: "error",
                msg: "Speculum dropping stale entries",
                raw: "raw 1",
                meta: { scopes: ["speculum"], engine: "speculum" },
            });
            created.ingest({
                v: 1,
                t: "event",
                source: "cake_live",
                ts: 1726844802,
                level: "info",
                msg: "unattributed line",
                raw: "raw 2",
                meta: { scopes: [] },
            });

            await fresh.flush();
            const lines = fresh.captureCharFrame();

            // Lines view: `time LEVEL msg #index` — no log/file column.
            // Sidebar tabs already filter by log; freed cells go to `msg`.
            expect(lines).toContain("connection=default");
            expect(lines).toContain("Speculum dropping stale entries");
            expect(lines).not.toContain("queries.log");
            expect(lines).not.toContain("speculum");
            expect(lines).not.toContain("[cake_live]");
            expect(lines).not.toContain("(queriesLog");
            expect(lines).not.toContain("cake.database.queries");
            // Level directly followed by msg (no `mcp.log`-style label between).
            expect(lines).toMatch(/DEBUG\s+connection=default/);

            // Cards view keeps file attribution in the header.
            created.ui.view = "cards";
            created.render();
            await fresh.flush();
            const cards = fresh.captureCharFrame();

            expect(cards).toContain("queries.log");
            expect(cards).toContain("Speculum dropping stale entries");
        } finally {
            await created?.destroy();
            fresh.renderer.destroy();
        }
    });

    test("level filter hides below-minimum rows, sidebar counts unchanged, footer badge", async () => {
        const { setup, app } = await boot();

        // 40 events: n % 5 === 0 is error (8), the rest info (32).
        app.ui.setMinLevel("warning");
        app.render();
        await setup.flush();

        const rows = app.visibleRows();
        expect(rows.length).toBe(8);
        expect(rows.every((e) => e.level === "error")).toBe(true);

        const frame = setup.captureCharFrame();

        expect(frame).toContain("lvl:warning+");
        expect(frame).toContain("message 35");
        // Sidebar counts/badges stay tab-only (text-filter precedent).
        expect(frame).toContain("All(40");
        // Info rows are gone from the content (the `top:` footer still samples
        // unfiltered events, so scope the negative check to non-footer lines).
        const content = frame
            .split("\n")
            .filter((l) => !l.includes("top:"))
            .join("\n");
        expect(content).not.toContain("message 39");
    });

    test("b toggles the sidebar, rows use the freed width", async () => {
        const { setup, app } = await boot();

        expect(setup.captureCharFrame()).toContain("All(40");

        // 63-char tail: truncated while the sidebar eats ~17 cells, full after.
        app.ingest({
            v: 1,
            t: "event",
            source: "cake_live",
            ts: 1726844900,
            level: "info",
            msg: `${"y".repeat(60)}END`,
            raw: "long",
            meta: { scope: "other" },
        });
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain("END");

        await setup.mockInput.pressKeys(["b"]);
        await setup.flush();

        const hidden = setup.captureCharFrame();
        expect(hidden).not.toContain("All(41");
        expect(hidden).toContain("END");

        // Digits still switch tabs while hidden.
        await setup.mockInput.pressKeys(["2"]);
        await setup.flush();
        expect(app.ui.tabIndex).toBe(1);

        await setup.mockInput.pressKeys(["b"]);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("All(41");
    });

    test("hidden sidebar never steals focus: tab/digits/arrows stay on content", async () => {
        const { setup, app } = await boot();

        await setup.mockInput.pressKeys(["b"]);
        await setup.flush();
        expect(app.ui.sidebarHidden).toBe(true);
        expect(app.ui.focus).toBe("content");

        // Tab must not strand focus on the invisible sidebar.
        await setup.mockInput.pressTab();
        await setup.flush();
        expect(app.ui.focus).toBe("content");

        // Digits still switch tabs but keep content focus + tail cursor.
        await setup.mockInput.pressKeys(["2"]);
        await setup.flush();
        expect(app.ui.tabIndex).toBe(1);
        expect(app.ui.focus).toBe("content");
        expect(app.ui.matchIndex).toBe(app.visibleRows().length - 1);

        // Arrows move the cursor, never switch tabs while hidden.
        const before = app.ui.tabIndex;
        const cursor = app.ui.matchIndex;
        await setup.mockInput.pressArrow("up");
        await setup.flush();
        expect(app.ui.tabIndex).toBe(before);
        expect(app.ui.matchIndex).toBe(cursor - 1);
        expect(app.ui.focus).toBe("content");
    });

    test("l opens the level modal, Esc cancels, Enter confirms", async () => {
        const { setup, app } = await boot();

        await setup.mockInput.pressKeys(["l"]);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("minimum level");

        await setup.mockInput.pressEscape();
        await setup.flush();
        expect(app.ui.minLevel).toBeNull();
        expect(setup.captureCharFrame()).not.toContain("minimum level");

        await setup.mockInput.pressKeys(["l"]);
        await setup.flush();
        // all → debug, then confirm.
        await setup.mockInput.pressArrow("down");
        await setup.flush();
        await setup.mockInput.pressEnter();
        await setup.flush();

        expect(app.ui.minLevel).toBe("debug");
        expect(setup.captureCharFrame()).not.toContain("minimum level");
        expect(setup.captureCharFrame()).toContain("lvl:debug+");
    });

    test("first Ctrl+C copies the mouse selection when one exists", async () => {
        const seen: string[] = [];
        const { setup } = await boot({
            writeClipboard: async (t: string) => {
                seen.push(t);
                return true;
            },
        });

        await setup.mockMouse.drag(30, 5, 80, 5);
        await setup.flush();
        setup.mockInput.pressCtrlC();
        await setup.flush();
        await new Promise((r) => setTimeout(r, 100));
        await setup.flush();

        expect(seen.length).toBe(1);
        expect(seen[0]).toContain("message");
        expect(setup.captureCharFrame()).toContain("copied selection");
    });

    test("first Ctrl+C without selection copies the active row", async () => {
        const seen: string[] = [];
        const { setup, app } = await boot({
            writeClipboard: async (t: string) => {
                seen.push(t);
                return true;
            },
        });

        setup.mockInput.pressCtrlC();
        await setup.flush();
        await new Promise((r) => setTimeout(r, 100));
        await setup.flush();

        expect(seen.length).toBe(1);
        // Cursor tracks the tail while following: copy acts on the visible tail.
        const allRows = app.visibleRows();
        const tail = allRows[allRows.length - 1];
        expect(tail).toBeDefined();
        expect(seen[0]).toContain("message 39 from other");
        expect(setup.captureCharFrame()).toContain("copied 1 row");
    });

    test("second Ctrl+C inside the window quits", async () => {
        const { setup, app } = await boot({
            writeClipboard: async () => true,
        });

        setup.mockInput.pressCtrlC();
        await setup.flush();
        await new Promise((r) => setTimeout(r, 100));
        expect((app as unknown as { destroyed: boolean }).destroyed).toBe(false);

        const origExit = process.exit;
        const exits: unknown[][] = [];
        (process as any).exit = (...args: unknown[]) => {
            exits.push(args);
            return undefined as never;
        };

        try {
            setup.mockInput.pressCtrlC();
            await setup.flush();
            await new Promise((r) => setTimeout(r, 100));
        } finally {
            process.exit = origExit;
        }

        expect((app as unknown as { destroyed: boolean }).destroyed).toBe(true);
        expect(exits.length).toBeGreaterThan(0);
    });

    for (const width of [80, 100, 120]) {
        test(`cards bottom keeps thumb with long footers (width ${width})`, async () => {
            const fresh = await createTestRenderer({ width, height: 30, useThread: false, maxFps: Number.POSITIVE_INFINITY });
            let created: App | null = null;

            try {
                created = await App.create(
                    {
                        fake: false,
                        sources: ["cake_live", "cake_file"],
                        terminal: { cols: width, rows: 30 },
                        view: "cards",
                        logConfigs: [{ name: "queries", file: "queries.log", scopes: null, levels: null }],
                    },
                    { renderer: fresh.renderer },
                );

                for (let i = 0; i < 120; i++) {
                    created.ingest({
                        v: 1,
                        t: "event",
                        source: "cake_live",
                        ts: 1726844800 + i,
                        level: "debug",
                        msg: `connection=default role=write duration=3.7 rows=1 INSERT INTO speculum_entries ${i}`,
                        raw: `row ${i}`,
                        meta: {
                            file: "queries.log",
                            origin: { type: "http", method: "GET", path: "/notification/notifications/unread.json" },
                            context: {
                                query: `UPDATE sessions SET data = :c0 , expires = :c1 WHERE id = '8c7d9503-fbfa-4f82-b02c-cd1a79f2cb20' AND padding ${"y".repeat(120)} ${i}`,
                            },
                        },
                    });
                }

                await fresh.flush();
                const frame = fresh.captureCharFrame();

                expect(frame).toContain("┃");
                expect(frame).not.toContain("▀");
                expect(frame).not.toContain("y".repeat(120));
            } finally {
                await created?.destroy();
                fresh.renderer.destroy();
            }
        });
    }

    test("? opens the help modal as an overlay, Esc closes it", async () => {
        const { setup } = await boot();

        await setup.mockInput.pressKeys(["?"]);
        await setup.flush();
        const help = setup.captureCharFrame();
        expect(help).toContain("Press ? or Esc to close");
        expect(help).toContain("switch to tab by number");
        expect(help).toContain("open the full event view");

        await setup.mockInput.pressEscape();
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain("Press ? or Esc to close");
    });

        test("modals never stack: ? then l keeps help, l then ? keeps level", async () => {
        const { setup } = await boot();

        await setup.mockInput.pressKeys(["?"]);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Press ? or Esc to close");

        await setup.mockInput.pressKeys(["l"]);
        await setup.flush();
        const helpFirst = setup.captureCharFrame();
        expect(helpFirst).toContain("Press ? or Esc to close");
        expect(helpFirst).not.toContain("↑↓ choose · Enter confirms");

        await setup.mockInput.pressEscape();
        await setup.flush();

        await setup.mockInput.pressKeys(["l"]);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("↑↓ choose · Enter confirms");

        await setup.mockInput.pressKeys(["?"]);
        await setup.flush();
        const levelFirst = setup.captureCharFrame();
        expect(levelFirst).toContain("↑↓ choose · Enter confirms");
        expect(levelFirst).not.toContain("Press ? or Esc to close");

        await setup.mockInput.pressEscape();
        await setup.flush();
    });

    test("shift pairs work through the real parser: N up, L rotates, G bottom", async () => {
        const { setup, app } = await boot();
        const total = app.visibleRows().length;

        // Cursor tracks the tail while following: n wraps tail -> head.
        expect(app.ui.matchIndex).toBe(total - 1);
        await setup.mockInput.pressKeys(["n"]);
        await setup.flush();
        expect(app.ui.matchIndex).toBe(0);

        await setup.mockInput.pressKeys(["N"]);
        await setup.flush();
        expect(app.ui.matchIndex).toBe(total - 1);

        // G scrolls to the bottom (went to top like g before the fix).
        // (n/N above re-followed on wrapping to the tail.)
        await setup.mockInput.pressKeys(["g"]);
        await setup.flush();
        expect(app.ui.scrollOffset).toBe(0);
        expect(app.ui.matchIndex).toBe(0);

        await setup.mockInput.pressKeys(["G"]);
        await setup.flush();
        expect(app.ui.scrollOffset).toBeGreaterThan(0);
        expect(app.ui.follow).toBe(true);
        expect(app.ui.matchIndex).toBe(app.visibleRows().length - 1);

        // L rotates the minimum level without opening the modal.
        await setup.mockInput.pressKeys(["L"]);
        await setup.flush();
        expect(app.ui.minLevel).toBe("debug");
        expect(setup.captureCharFrame()).not.toContain("↑↓ choose · Enter confirms");
    });

    test("Enter opens the full view for the active row, Esc closes it", async () => {

        const { setup, app } = await boot();

        await setup.mockInput.pressEnter();
        await setup.flush();

        expect(app.fullOpen).toBe(true);
        expect(setup.captureCharFrame()).toContain("↑↓ scroll · Esc closes");

        await setup.mockInput.pressEscape();
        await setup.flush();
        expect(app.fullOpen).toBe(false);
    });

    test("index rows show only the statement, full view splits attributes first", async () => {
        const fresh = await createTestRenderer({ width: 100, height: 30, useThread: false, maxFps: Number.POSITIVE_INFINITY });
        let created: App | null = null;

        try {
            created = await App.create(
                {
                    fake: false,
                    sources: ["cake_live", "cake_file"],
                    terminal: { cols: 100, rows: 30 },
                    logConfigs: [{ name: "queries", file: "queries.log", scopes: null, levels: null }],
                },
                { renderer: fresh.renderer },
            );

            created.ingest({
                v: 1,
                t: "event",
                source: "cake_live",
                ts: 1726844800,
                level: "debug",
                msg: "connection=default role=write duration=3.2 rows=1 SELECT * FROM articles WHERE id = 7",
                raw: "connection=default role=write duration=3.2 rows=1 SELECT * FROM articles WHERE id = 7",
                meta: { file: "queries.log" },
            });
            await fresh.flush();

            // The `top:` footer samples raw messages, so scope the negative
            // checks to non-footer lines (level-filter test precedent).
            const contentOf = (frame: string) =>
                frame
                    .split("\n")
                    .filter((l) => !l.includes("top:"))
                    .join("\n");

            const lines = fresh.captureCharFrame();
            expect(lines).toContain("SELECT * FROM articles");
            expect(contentOf(lines)).not.toContain("connection=default");

            created.ui.view = "cards";
            created.render();
            await fresh.flush();
            const cards = fresh.captureCharFrame();
            expect(cards).toContain("SELECT * FROM articles");
            expect(contentOf(cards)).not.toContain("connection=default");

            const first = created.visibleRows()[0];
            expect(first).toBeDefined();

            if (first !== undefined) {
                created.openFull(first);
            }

            await fresh.flush();
            const full = fresh.captureCharFrame();
            expect(full).toContain("connection=default role=write duration=3.2 rows=1");
            expect(full).toContain("SELECT * FROM articles");
        } finally {
            await created?.destroy();
            fresh.renderer.destroy();
        }
    });
});
