import { describe, expect, test } from "bun:test";
import { ensureVisible, nextMatch, prevMatch } from "./store/search.js";
import { UiState } from "./store/ui.js";
import { toFlatLine } from "./ui/CardList.js";
import type { LogEvent } from "./protocol.js";

function ev(msg = "hello"): LogEvent {
    return { v: 1, t: "event", source: "a", ts: 1, level: "info", msg, raw: msg, meta: {} };
}

function visibleWidth(styled: { chunks: { text: string }[] }): number {
    return styled.chunks.reduce((n, c) => n + (c.text ?? "").length, 0);
}

describe("cursor", () => {
    test("moveCursor clamps at both ends, no wrap", () => {
        const ui = new UiState(["a"]);
        expect(ui.moveCursor(1, 5)).toBe(1);
        expect(ui.moveCursor(99, 5)).toBe(4);
        expect(ui.moveCursor(-99, 5)).toBe(0);
        expect(ui.moveCursor(-1, 5)).toBe(0);
        expect(ui.moveCursor(1, 0)).toBe(0);
    });

    test("n/N keep wrap-around", () => {
        expect(nextMatch(4, 5)).toBe(0);
        expect(prevMatch(0, 5)).toBe(4);
        expect(nextMatch(0, 0)).toBe(0);
    });

    test("ensureVisible default 0 pins to the edge, margin 2 rides inside", () => {
        // Legacy: cursor glued to the bottom edge.
        expect(ensureVisible(10, 0, 5, 20)).toBe(6);
        // With margin: 2 rows of context below the cursor.
        expect(ensureVisible(10, 0, 5, 20, 2)).toBe(8);
        // Scrolling up: 2 rows above.
        expect(ensureVisible(3, 5, 5, 20, 2)).toBe(1);
        // Clamps hold.
        expect(ensureVisible(0, 0, 5, 20, 2)).toBe(0);
        expect(ensureVisible(99, 0, 5, 20, 2)).toBe(20);
    });

    test("tail tracking on follow-toggle / ingest / bottom", () => {
        const ui = new UiState(["a"]);
        ui.matchIndex = 0;
        // toggleFollow off first (starts following), then on anchors to last.
        ui.toggleFollow(10);
        expect(ui.follow).toBe(false);
        ui.toggleFollow(10, 11);
        expect(ui.follow).toBe(true);
        expect(ui.matchIndex).toBe(10);

        ui.scrollToTop();
        ui.scrollToBottom(10, 11);
        expect(ui.matchIndex).toBe(10);

        ui.scrollToTop();
        ui.onIngest(12, 13);
        // Unfollowed ingest raises hasNew, cursor untouched.
        expect(ui.hasNew).toBe(true);
        expect(ui.matchIndex).toBe(0);

        const ui2 = new UiState(["a"]);
        ui2.onIngest(12, 13);
        expect(ui2.matchIndex).toBe(12);
        expect(ui2.scrollOffset).toBe(12);
    });

    test("syncFollowAfterCursor: only tail + bottom stays following", () => {
        const ui = new UiState(["a"]);
        ui.matchIndex = 9;
        ui.scrollOffset = 5;
        ui.syncFollowAfterCursor(5, 10);
        expect(ui.follow).toBe(true);

        ui.moveCursor(-1, 10);
        ui.syncFollowAfterCursor(5, 10);
        expect(ui.follow).toBe(false);
    });

    test("card gutter keeps active/inactive budgets equal", () => {
        const line = "┌ 07:27:07 DEBUG queries.log some message body here";
        const active = toFlatLine(ev(), line, true, 40);
        const inactive = toFlatLine(ev(), line, false, 40);
        // Both reserve the 2-cell gutter: same visible cell count.
        expect(visibleWidth(active)).toBe(visibleWidth(inactive));
        expect(active.chunks[0]?.text).toBe("» ");
        expect(inactive.chunks[0]?.text).toBe("  ");
    });
});
