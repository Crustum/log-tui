import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { debugLog, debugLogPath } from "./debug.js";

describe("debugLog", () => {
    test("gated off by default and never throws", () => {
        delete process.env.CAKE_LOGS_TUI_DEBUG;

        expect(() => debugLog("hello", { a: 1 }, new Error("x"))).not.toThrow();
    });

    test("writes timestamped lines when enabled", () => {
        const marker = `marker-${Date.now()}-${Math.random()}`;

        process.env.CAKE_LOGS_TUI_DEBUG = "1";

        try {
            debugLog(marker, { k: "v" });
        } finally {
            delete process.env.CAKE_LOGS_TUI_DEBUG;
        }

        const content = readFileSync(debugLogPath(), "utf8");

        expect(content).toContain(marker);
        expect(statSync(debugLogPath()).size).toBeGreaterThan(0);
    });
});
