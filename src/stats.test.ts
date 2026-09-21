import { describe, expect, test } from "bun:test";
import { setTheme, getTheme, toggleTheme } from "./format/theme.js";
import { levelColor } from "./format/highlight.js";
import { Counters, sparkline } from "./store/counters.js";
import { ensureVisible, nextMatch, prevMatch } from "./store/search.js";
import { normalizeMsg, TopTracker } from "./store/top.js";
import { PROTOCOL_VERSION, type LogEvent } from "./protocol.js";

function ev(ts: number, level: LogEvent["level"] = "error", source = "cake_live", msg = "m"): LogEvent {
    return { v: PROTOCOL_VERSION, t: "event", source, ts, level, msg, raw: msg, meta: {} };
}

describe("search navigation", () => {
    test("next/prev wrap, empty stays 0", () => {
        expect(nextMatch(2, 3)).toBe(0);
        expect(nextMatch(0, 0)).toBe(0);
        expect(prevMatch(0, 3)).toBe(2);
        expect(prevMatch(0, 0)).toBe(0);
    });

    test("ensureVisible scrolls cursor into view", () => {
        expect(ensureVisible(25, 0, 20, 80)).toBe(6);
        expect(ensureVisible(5, 10, 20, 80)).toBe(5);
        expect(ensureVisible(12, 10, 20, 80)).toBe(10);
    });
});

describe("sparkline", () => {
    test("renders block elements scaled to max", () => {
        expect(sparkline([0, 0, 0])).toBe("▁▁▁");
        expect(sparkline([1, 0]).length).toBe(2);
        expect(sparkline([4, 0])).toBe("█▁");
    });

    test("buckets count errors per window", () => {
        const c = new Counters();
        c.record(ev(1000));
        c.record(ev(999));
        c.record(ev(900));
        const buckets = c.errorsSparkline(1000, 12, 5);

        expect(buckets.length).toBe(12);
        expect(buckets.reduce((a, b) => a + b, 0)).toBe(2);
        expect(c.errorsPerMinute(1000)).toBe(2);
    });
});

describe("top-N", () => {
    test("normalizes digits and UUIDs", () => {
        expect(normalizeMsg("timeout after 30s")).toBe("timeout after #s");
        expect(normalizeMsg("job 123e4567-e89b-12d3-a456-426614174000 done")).toBe("job #uuid done");
    });

    test("groups repeats, top sorted", () => {
        const t = new TopTracker();
        t.record(ev(1, "error", "cake_live", "DB timeout after 30s"));
        t.record(ev(2, "error", "cake_live", "DB timeout after 45s"));
        t.record(ev(3, "info", "cake_live", "GET /x 200"));

        const top = t.top(2);

        expect(top[0]?.count).toBe(2);
        expect(top[0]?.sample).toBe("DB timeout after 45s");
        expect(top.length).toBe(2);
    });

    test("clear(source) scopes to one source", () => {
        const t = new TopTracker();
        t.record(ev(1, "error", "a", "boom 1"));
        t.record(ev(2, "error", "b", "boom 2"));
        t.clear("a");

        expect(t.top(5).map((e) => e.sample)).toEqual(["boom 2"]);
    });
});

describe("themes", () => {
    test("toggle flips dark/light and level colors follow", () => {
        setTheme("dark");
        const dark = levelColor("error");

        toggleTheme();

        expect(getTheme().name).toBe("light");
        expect(levelColor("error")).not.toBe(dark);

        setTheme("dark");
    });
});
