import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type LogEvent } from "./protocol.js";
import { buildTabs, matchesTab, type Tab } from "./store/engineTabs.js";

function live(level: LogEvent["level"], scopes: string[] = [], msg = "m"): LogEvent {
    return { v: PROTOCOL_VERSION, t: "event", source: "cake_live", ts: 1, level, msg, raw: msg, meta: { scopes } };
}

function tabByTitle(tabs: Tab[], title: string): Tab {
    const tab = tabs.find((t) => t.title === title);

    if (!tab) {
        throw new Error(`missing tab ${title}`);
    }

    return tab;
}

function tabAt(tabs: Tab[], index: number): Tab {
    const tab = tabs[index];

    if (!tab) {
        throw new Error(`missing tab at ${index}`);
    }

    return tab;
}

function file(level: LogEvent["level"], file: string, msg = "m"): LogEvent {
    return { v: PROTOCOL_VERSION, t: "event", source: "cake_file", ts: 1, level, msg, raw: msg, meta: { file } };
}

const CONFIGS = [
    { name: "debug", file: "debug.log", scopes: null, levels: null },
    { name: "all", file: "all.log", scopes: null, levels: null },
    { name: "error", file: "error.log", scopes: null, levels: ["error", "critical", "alert", "emergency"] },
    { name: "payments", file: "payments.log", scopes: ["payments"], levels: null },
];

describe("buildTabs", () => {
    test("default order: All → engines (no raw source tabs)", () => {
        const tabs = buildTabs({ sources: ["cake_live", "cake_file"], logConfigs: CONFIGS });

        expect(tabs.map((t) => t.title)).toEqual(["All", "debug", "all", "error", "payments"]);
        expect(tabs[0]?.kind).toBe("all");
        expect(tabs[1]?.kind).toBe("engine");
    });

    test("fallback with no configs: All + per source, no raw ids", () => {
        const tabs = buildTabs({ sources: ["cake_live", "cake_file"] });

        expect(tabs.map((t) => t.title)).toEqual(["All", "live", "file"]);
        expect(tabs.map((t) => t.kind)).toEqual(["all", "source", "source"]);
    });

    test("engines with neither file nor scopes get no tab", () => {
        const tabs = buildTabs({
            sources: ["cake_live", "cake_file"],
            logConfigs: [
                { name: "console", file: null, scopes: null, levels: null },
                { name: "scoped", file: null, scopes: ["web"], levels: null },
                ...CONFIGS,
            ],
        });
        const titles = tabs.map((t) => t.title);

        expect(titles).not.toContain("console");
        expect(titles).toContain("scoped");
    });

    test("explicit tabs replace derived defaults, All stays first", () => {
        const tabs = buildTabs({
            sources: ["cake_live", "cake_file"],
            logConfigs: CONFIGS,
            explicitTabs: [{ title: "pay", scopes: ["payments"] }],
        });

        expect(tabs.map((t) => t.title)).toEqual(["All", "pay"]);
        expect(tabs[1]?.kind).toBe("custom");
    });
});

describe("engine tab overlap (debug vs all vs error)", () => {
    const tabs = buildTabs({ sources: ["cake_live", "cake_file"], logConfigs: CONFIGS });
    const debug = tabByTitle(tabs, "debug");
    const all = tabByTitle(tabs, "all");
    const error = tabByTitle(tabs, "error");

    test("file attribution by basename, overlap is faithful", () => {
        // debug.log line appears in debug tab only (not error/all — different files).
        expect(matchesTab(file("info", "debug.log"), debug)).toBe(true);
        expect(matchesTab(file("info", "debug.log"), error)).toBe(false);
        expect(matchesTab(file("info", "debug.log"), all)).toBe(false);
        // error.log line appears in error tab only.
        expect(matchesTab(file("error", "error.log"), error)).toBe(true);
        expect(matchesTab(file("error", "error.log"), debug)).toBe(false);
    });

    test("level re-gating skipped for file events", () => {
        // A debug line in error.log still shows (engine filtered at write time).
        expect(matchesTab(file("debug", "error.log"), error)).toBe(true);
    });
});

describe("file attribution suffix", () => {
    const tabs = buildTabs({
        sources: ["cake_file"],
        logConfigs: [{ name: "email", file: "email", scopes: null, levels: null }],
    });
    const email = tabAt(tabs, 1);

    test("matches with and without .log suffix", () => {
        expect(matchesTab(file("info", "email"), email)).toBe(true);
        expect(matchesTab(file("info", "email.log"), email)).toBe(true);
        expect(matchesTab(file("info", "other.log"), email)).toBe(false);
    });
});

describe("live routing by scope intersection", () => {
    const tabs = buildTabs({ sources: ["cake_live"], logConfigs: CONFIGS });
    const payments = tabByTitle(tabs, "payments");
    const debug = tabByTitle(tabs, "debug");
    const error = tabByTitle(tabs, "error");

    test("scoped events match scoped engines by intersection", () => {
        expect(matchesTab(live("info", ["payments"]), payments)).toBe(true);
        expect(matchesTab(live("info", ["db"]), payments)).toBe(false);
        expect(matchesTab(live("info", ["db", "payments"]), payments)).toBe(true);
    });

    test("unscoped live events match scopes-null engines only", () => {
        expect(matchesTab(live("info", []), debug)).toBe(true);
        expect(matchesTab(live("info", []), payments)).toBe(false);
    });

    test("level-banded engine gates live events", () => {
        expect(matchesTab(live("error", []), error)).toBe(true);
        expect(matchesTab(live("warning", []), error)).toBe(false);
    });
});

describe("custom tabs", () => {
    const tabs = buildTabs({
        sources: ["cake_live", "cake_file"],
        explicitTabs: [
            { title: "pay", scopes: ["payments"] },
            { title: "errors", files: ["error.log"], level: "warning" },
        ],
    });
    const pay = tabAt(tabs, 1);
    const errors = tabAt(tabs, 2);

    test("scope selector matches live and JSON file events", () => {
        expect(matchesTab(live("info", ["payments"]), pay)).toBe(true);
        expect(matchesTab(live("info", ["db"]), pay)).toBe(false);
    });

    test("level is a minimum severity", () => {
        expect(matchesTab(file("error", "error.log"), errors)).toBe(true);
        expect(matchesTab(file("critical", "error.log"), errors)).toBe(true);
        expect(matchesTab(file("info", "error.log"), errors)).toBe(false);
        expect(matchesTab(live("error", []), errors)).toBe(false);
    });
});
