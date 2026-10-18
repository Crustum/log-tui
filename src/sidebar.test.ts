import { describe, expect, test } from "bun:test";
import { contrastText, TAB_COLORS_DARK, tabColor } from "./format/tabColors.js";
import { formatSidebarRow, sidebarWidth } from "./ui/Sidebar.js";
import { UiState, filterRowsFor, viewportRows } from "./store/ui.js";

describe("sidebar", () => {
    test("rows show number and title only (counts live in the header)", () => {
        expect(formatSidebarRow(0, { title: "All", kind: "all" })).toBe("1 All");
        expect(formatSidebarRow(1, { title: "payments", kind: "engine" })).toBe("2 payments");
        expect(formatSidebarRow(9, { title: "x", kind: "all" })[0]).toBe(" ");
    });

    test("width clamps to [15,40]", () => {
        expect(sidebarWidth([])).toBe(15);
        expect(sidebarWidth(["1 All"])).toBe(15);
        expect(sidebarWidth([`9 ${"x".repeat(100)}`])).toBe(40);
        expect(sidebarWidth(["1 All", "2 payments-upsell-team"])).toBe("2 payments-upsell-team".length + 2);
    });

    test("tab colors follow the shared ProcessColor palette", () => {
        // `All` stays neutral; streams cycle the multiplex palette in order.
        expect(tabColor(0)).toBeNull();
        expect(tabColor(1)).toBe(TAB_COLORS_DARK[0]);
        expect(tabColor(2)).toBe(TAB_COLORS_DARK[1]);
        expect(tabColor(TAB_COLORS_DARK.length + 1)).toBe(TAB_COLORS_DARK[0]);
        // Pastel fills take black labels (multiplex `contrastText` parity).
        for (const color of TAB_COLORS_DARK) {
            expect(contrastText(color)).toBe("#000000");
        }
    });
});

describe("viewport", () => {
    test("derives from terminal size, filter and status rows", () => {
        // 24 rows, closed filter (1), status (2): 24-1-1-2-2-1(content header) = 17.
        expect(viewportRows(24, 1, 2)).toBe(17);
        // Framed open filter (4): 24-1-4-4-2-1 = 12.
        expect(viewportRows(24, 4, 4)).toBe(12);
        expect(viewportRows(10, 4, 4)).toBe(3);
    });

    test("filterRowsFor", () => {
        expect(filterRowsFor("closed")).toBe(1);
        expect(filterRowsFor("global")).toBe(4);
        expect(filterRowsFor("tab")).toBe(4);
    });
});

describe("follow state machine", () => {
    test("onIngest sticks when following, raises hasNew otherwise", () => {
        const ui = new UiState(["a"]);

        ui.onIngest(10);
        expect(ui.scrollOffset).toBe(10);
        expect(ui.hasNew).toBe(false);

        ui.scrollToTop();
        ui.onIngest(12);
        expect(ui.scrollOffset).toBe(0);
        expect(ui.hasNew).toBe(true);
    });

    test("toggleFollow jumps to bottom or stays", () => {
        const ui = new UiState(["a"]);

        ui.toggleFollow(5);
        expect(ui.follow).toBe(false);

        ui.scrollOffset = 2;
        ui.hasNew = true;
        ui.toggleFollow(9);
        expect(ui.follow).toBe(true);
        expect(ui.scrollOffset).toBe(9);
        expect(ui.hasNew).toBe(false);
    });

    test("scrollToBottom clears hasNew; resetView restores follow", () => {
        const ui = new UiState(["a"]);

        ui.scrollToTop();
        ui.hasNew = true;
        ui.scrollToBottom(7);
        expect(ui.hasNew).toBe(false);

        ui.scrollToTop();
        ui.resetView();
        expect(ui.follow).toBe(true);
        expect(ui.hasNew).toBe(false);
    });

    test("focus and view toggles", () => {
        const ui = new UiState(["a"]);

        expect(ui.focus).toBe("content");
        ui.toggleFocus();
        expect(ui.focus).toBe("sidebar");

        expect(ui.view).toBe("lines");
        ui.toggleView();
        expect(ui.view).toBe("cards");
        expect(ui.scrollOffset).toBe(0);
    });
});
