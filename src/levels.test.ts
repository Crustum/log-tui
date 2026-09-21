import { describe, expect, test } from "bun:test";
import { LEVELS, type Level } from "./protocol.js";
import { meetsMinLevel, nextMinLevel } from "./store/levels.js";

describe("nextMinLevel", () => {
    test("cycles all → debug → … → emergency → all", () => {
        const seen: Array<Level | null> = [];
        let cur: Level | null = null;

        for (let i = 0; i < LEVELS.length + 1; i++) {
            cur = nextMinLevel(cur);
            seen.push(cur);
        }

        expect(seen).toEqual([...LEVELS, null]);
    });

    test("unknown level resets to all", () => {
        expect(nextMinLevel("bogus" as Level)).toBeNull();
    });
});

describe("meetsMinLevel", () => {
    test("null keeps everything", () => {
        for (const level of LEVELS) {
            expect(meetsMinLevel(level, null)).toBe(true);
        }
    });

    test("warning keeps warning and above only", () => {
        expect(meetsMinLevel("debug", "warning")).toBe(false);
        expect(meetsMinLevel("info", "warning")).toBe(false);
        expect(meetsMinLevel("notice", "warning")).toBe(false);
        expect(meetsMinLevel("warning", "warning")).toBe(true);
        expect(meetsMinLevel("error", "warning")).toBe(true);
        expect(meetsMinLevel("emergency", "warning")).toBe(true);
    });

    test("emergency keeps only emergency", () => {
        expect(meetsMinLevel("alert", "emergency")).toBe(false);
        expect(meetsMinLevel("emergency", "emergency")).toBe(true);
    });

    test("debug keeps everything", () => {
        for (const level of LEVELS) {
            expect(meetsMinLevel(level, "debug")).toBe(true);
        }
    });
});
