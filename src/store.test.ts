import { describe, expect, test } from "bun:test";
import { keyToAction } from "./input/keys.js";
import { matchesFilter, parseFilter } from "./store/filters.js";
import type { LogEvent } from "./protocol.js";

function ev(level: LogEvent["level"] = "error", msg = "DB timeout", scope?: string): LogEvent {
    return {
        v: 1,
        t: "event",
        source: "cake_live",
        ts: 1,
        level,
        msg,
        raw: msg,
        meta: scope ? { scope } : {},
    };
}

describe("filters", () => {
    test("level>=warning filters debug", () => {
        const expr = parseFilter('level>=warning && msg~"timeout"');

        expect(matchesFilter(ev("error", "DB timeout"), expr)).toBe(true);
        expect(matchesFilter(ev("debug", "DB timeout"), expr)).toBe(false);
        expect(matchesFilter(ev("error", "ok"), expr)).toBe(false);
    });

    test("scope= matches meta.scope", () => {
        const expr = parseFilter("scope=payments");

        expect(matchesFilter(ev("info", "x", "payments"), expr)).toBe(true);
        expect(matchesFilter(ev("info", "x", "db"), expr)).toBe(false);
    });

    test("plain text falls back to substring", () => {
        const expr = parseFilter("timeout");

        expect(matchesFilter(ev("info", "DB Timeout!"), expr)).toBe(true);
        expect(matchesFilter(ev("info", "ok"), expr)).toBe(false);
    });

    test("empty filter matches everything", () => {
        expect(matchesFilter(ev(), parseFilter(""))).toBe(true);
    });
});

describe("keys", () => {
    test("maps navigation and actions", () => {
        expect(keyToAction({ name: "1" }, false)).toBe("tab:1");
        expect(keyToAction({ name: "tab" }, false)).toBe("focus:toggle");
        expect(keyToAction({ name: "s" }, false)).toBe("follow:toggle");
        expect(keyToAction({ name: "v" }, false)).toBe("view:toggle");
        expect(keyToAction({ name: "j" }, false)).toBe("scroll:down");
        expect(keyToAction({ name: "g" }, false)).toBe("scroll:top");
        expect(keyToAction({ name: "/" }, false)).toBe("filter:open");
        expect(keyToAction({ name: "q" }, false)).toBe("quit");
        expect(keyToAction({ name: "return" }, true)).toBe("filter:confirm");
        expect(keyToAction({ name: "escape" }, true)).toBe("filter:cancel");
        expect(keyToAction({ name: "a" }, true)).toBeNull();
        expect(keyToAction({ name: "f" }, false)).toBe("filter:open-tab");
        expect(keyToAction({ name: "t" }, false)).toBe("theme:toggle");
        expect(keyToAction({ name: "l" }, false)).toBe("level:open");
        expect(keyToAction({ name: "L" }, false)).toBe("level:rotate");
        expect(keyToAction({ name: "c", ctrl: true }, false)).toBe("quit:press");
        expect(keyToAction({ name: "b" }, false)).toBe("sidebar:toggle");
    });

    test("shift+letter pairs never collapse onto the lowercase action", () => {
        // Mock/kitty uppercase form.
        expect(keyToAction({ name: "N" }, false)).toBe("match:prev");
        expect(keyToAction({ name: "L" }, false)).toBe("level:rotate");
        expect(keyToAction({ name: "G" }, false)).toBe("scroll:bottom");
        // Real-terminal form: lowercase name + shift flag.
        expect(keyToAction({ name: "n", shift: true }, false)).toBe("match:prev");
        expect(keyToAction({ name: "l", shift: true }, false)).toBe("level:rotate");
        expect(keyToAction({ name: "g", shift: true }, false)).toBe("scroll:bottom");
        // Raw-char sequence fallback.
        expect(keyToAction({ name: "n", sequence: "N" }, false)).toBe("match:prev");
        // Plain letters are unaffected.
        expect(keyToAction({ name: "n" }, false)).toBe("match:next");
        expect(keyToAction({ name: "l" }, false)).toBe("level:open");
        expect(keyToAction({ name: "g" }, false)).toBe("scroll:top");
    });
});
