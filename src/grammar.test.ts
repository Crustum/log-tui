import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type LogEvent } from "./protocol.js";
import { matchesFilter, parseFilter } from "./store/filters.js";

function ev(level: LogEvent["level"] = "info", msg = "x", meta: Record<string, unknown> = {}): LogEvent {
    return { v: PROTOCOL_VERSION, t: "event", source: "cake_live", ts: 1, level, msg, raw: msg, meta };
}

describe("grammar v1 extras", () => {
    test("|| alternation", () => {
        const expr = parseFilter('level=error || level=critical');

        expect(matchesFilter(ev("error"), expr)).toBe(true);
        expect(matchesFilter(ev("critical"), expr)).toBe(true);
        expect(matchesFilter(ev("info"), expr)).toBe(false);
    });

    test("&& binds tighter than ||", () => {
        const expr = parseFilter('scope=a || scope=b && level=error');

        expect(matchesFilter(ev("error", "x", { scope: "b" }), expr)).toBe(true);
        expect(matchesFilter(ev("info", "x", { scope: "b" }), expr)).toBe(false);
        expect(matchesFilter(ev("info", "x", { scope: "a" }), expr)).toBe(true);
    });

    test("parens override precedence", () => {
        const expr = parseFilter('(scope=a || scope=b) && level=error');

        expect(matchesFilter(ev("error", "x", { scope: "a" }), expr)).toBe(true);
        expect(matchesFilter(ev("info", "x", { scope: "a" }), expr)).toBe(false);
    });

    test("file= matches meta.file, .log-tolerant", () => {
        const expr = parseFilter("file=error.log");

        expect(matchesFilter(ev("info", "x", { file: "error.log" }), expr)).toBe(true);
        expect(matchesFilter(ev("info", "x", { file: "error" }), expr)).toBe(true);
        expect(matchesFilter(ev("info", "x", { file: "debug.log" }), expr)).toBe(false);
        expect(matchesFilter(ev("info", "x", {}), expr)).toBe(false);
    });

    test("scope= understands plural meta.scopes", () => {
        const expr = parseFilter("scope=payments");

        expect(matchesFilter(ev("info", "x", { scopes: ["db", "payments"] }), expr)).toBe(true);
        expect(matchesFilter(ev("info", "x", { scopes: ["db"] }), expr)).toBe(false);
    });

    test("demo query from the plan", () => {
        const expr = parseFilter('level>=warning && msg~"db"');

        expect(matchesFilter(ev("error", "DB timeout", { scope: "payments" }), expr)).toBe(true);
        expect(matchesFilter(ev("info", "DB timeout", { scope: "payments" }), expr)).toBe(false);
        expect(matchesFilter(ev("error", "ok", { scope: "payments" }), expr)).toBe(false);
    });
});
