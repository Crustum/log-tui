import { describe, expect, test } from "bun:test";
import { parseServerLine } from "./protocol.js";

describe("parseServerLine", () => {
    test("accepts a valid event", () => {
        const msg = parseServerLine(
            JSON.stringify({ v: 1, t: "event", source: "cake_live", ts: 1.5, level: "error", msg: "x", raw: "x", meta: {} }),
        );

        expect(msg?.t).toBe("event");
    });

    test("ignores unknown t and malformed lines", () => {
        expect(parseServerLine(JSON.stringify({ v: 1, t: "future", x: 1 }))).toBeNull();
        expect(parseServerLine("not json")).toBeNull();
        expect(parseServerLine(JSON.stringify({ v: 2, t: "event" }))).toBeNull();
    });
});
