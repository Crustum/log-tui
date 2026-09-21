import { describe, expect, test } from "bun:test";
import { LogsStore } from "./store/logs.js";
import type { LogEvent } from "./protocol.js";

function ev(source: string, i: number): LogEvent {
    return { v: 1, t: "event", source, ts: i, level: "info", msg: `m${i}`, raw: `m${i}`, meta: {} };
}

describe("LogsStore", () => {
    test("drop-oldest counts dropped", () => {
        const store = new LogsStore(["a"], 3);

        for (let i = 0; i < 5; i++) {
            store.push(ev("a", i));
        }

        expect(store.forSource("a").length).toBe(3);
        expect(store.droppedCount("a")).toBe(2);
        expect(store.forSource("a")[0]?.msg).toBe("m2");
    });

    test("all() merges sorted by ts", () => {
        const store = new LogsStore(["a", "b"]);
        store.push(ev("b", 2));
        store.push(ev("a", 1));

        expect(store.all().map((e) => e.ts)).toEqual([1, 2]);
    });

    test("clear() scopes to source", () => {
        const store = new LogsStore(["a", "b"]);
        store.push(ev("a", 1));
        store.push(ev("b", 2));
        store.clear("a");

        expect(store.forSource("a").length).toBe(0);
        expect(store.forSource("b").length).toBe(1);
    });
});
