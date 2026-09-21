import { describe, expect, test } from "bun:test";
import { expandQueryPrefix, parseQueryPrefix, stripQueryPrefix } from "./queryPrefix.js";
import { buildFullLines } from "../ui/FullView.js";
import type { LogEvent } from "../protocol.js";

const QUERY = "connection=default role=write duration=3.2 rows=1 INSERT INTO articles (title) VALUES ('x')";

function ev(msg: string): LogEvent {
    return { v: 1, t: "event", source: "cake_live", ts: 1726844800, level: "debug", msg, raw: msg, meta: {} };
}

describe("queryPrefix", () => {
    test("parse splits Cake SQL-logger attributes from the statement", () => {
        expect(parseQueryPrefix(QUERY)).toEqual({
            attrs: "connection=default role=write duration=3.2 rows=1",
            sql: "INSERT INTO articles (title) VALUES ('x')",
        });
    });

    test("parse accepts other statements and rejects non-queries", () => {
        expect(parseQueryPrefix("connection=default duration=1 SELECT * FROM t")).not.toBeNull();
        expect(parseQueryPrefix("connection=default role=write duration=3.7 rows=1")).toBeNull();
        expect(parseQueryPrefix("GET /articles 200")).toBeNull();
        expect(parseQueryPrefix("a=b just a message")).toBeNull();
        expect(parseQueryPrefix("")).toBeNull();
    });

    test("strip keeps only the statement, preserving later lines", () => {
        expect(stripQueryPrefix(QUERY)).toBe("INSERT INTO articles (title) VALUES ('x')");
        expect(stripQueryPrefix(`${QUERY}\nsecond line`)).toBe("INSERT INTO articles (title) VALUES ('x')\nsecond line");
        expect(stripQueryPrefix("plain message")).toBe("plain message");
    });

    test("expand puts attributes on their own first line", () => {
        expect(expandQueryPrefix(QUERY)).toEqual([
            "connection=default role=write duration=3.2 rows=1",
            "INSERT INTO articles (title) VALUES ('x')",
        ]);
        expect(expandQueryPrefix("plain")).toEqual(["plain"]);
        expect(expandQueryPrefix("")).toEqual(["No message."]);
    });

    test("full view shows attributes first, then the query", () => {
        const lines = buildFullLines(ev(QUERY));

        expect(lines[0]).toBe("connection=default role=write duration=3.2 rows=1");
        expect(lines[1]).toBe("INSERT INTO articles (title) VALUES ('x')");
    });
});
