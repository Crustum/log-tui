import { describe, expect, test } from "bun:test";
import {
    authLabel,
    cardBodyLines,
    cardFooterParts,
    cardLineCount,
    cardStarts,
    describeCard,
    originLabel,
    renderCard,
    truncate,
} from "./format/cards.js";
import type { LogEvent } from "./protocol.js";

function ev(partial: Partial<LogEvent> = {}): LogEvent {
    return {
        v: 1,
        t: "event",
        source: "cake_live",
        ts: 1726844805,
        level: "debug",
        msg: "hello",
        raw: "hello",
        meta: {},
        ...partial,
    };
}

describe("cards", () => {
    test("header carries level, exception class and file", () => {
        const desc = describeCard(
            ev({
                level: "error",
                meta: { file: "error.log", exception: { class: "RuntimeError", message: "boom" } },
            }),
            80,
        );

        expect(desc.header).toContain("ERROR");
        expect(desc.header).toContain("RuntimeError");
        expect(desc.header).toContain("error.log");
    });

    test("body caps at 5 lines, keeps wide lines for wrapping", () => {
        const body = cardBodyLines(ev({ msg: "a\nb\nc\nd\ne\nf\ng" }), 80);

        expect(body).toEqual(["a", "b", "c", "d", "e"]);
        expect(cardBodyLines(ev({ msg: "x".repeat(50) }), 10)).toEqual(["x".repeat(50)]);
        expect(cardBodyLines(ev({ msg: "" }), 80)).toEqual(["No message."]);
    });

    test("http footer mirrors CliPrinter (method path + guest/auth)", () => {
        expect(cardFooterParts(ev({ meta: { origin: { type: "http", method: "GET", path: "/n" } } }))).toEqual([
            "GET /n",
            "guest",
        ]);
        expect(
            cardFooterParts(
                ev({ meta: { origin: { type: "http", method: "POST", path: "/p", auth: 7, auth_email: "a@b.c" } } }),
            ),
        ).toEqual(["POST /p", "Auth: 7 (a@b.c)"]);
    });

    test("console footer and context pairs", () => {
        expect(cardFooterParts(ev({ meta: { origin: { type: "console", command: "worker" } } }))).toEqual([
            "console: worker",
        ]);
        expect(
            cardFooterParts(ev({ meta: { context: { scope: "payments", n: 3, deep: { a: 1 } } } })),
        ).toEqual(["scope: payments", "n: 3", 'deep: {"a":1}']);
        expect(cardFooterParts(ev())).toEqual([]);
    });

    test("authLabel/originLabel edge cases", () => {
        expect(authLabel({})).toBe("guest");
        expect(authLabel({ auth: 42 })).toBe("Auth: 42");
        expect(originLabel({})).toBeNull();
        expect(originLabel({ type: "console", command: "" })).toBeNull();
    });

    test("renderCard uses ┌/│/└ prefixes", () => {
        expect(renderCard({ header: "H", body: ["a", "b"], footer: "F" })).toEqual(["┌ H", "│ a", "│ b", "└ F"]);
        expect(renderCard({ header: "H", body: ["a"], footer: "" })[2]).toBe("└");
    });

    test("cardStarts prefix sums match line counts", () => {
        const rows = [ev({ msg: "one" }), ev({ msg: "a\nb\nc" }), ev({ msg: "" })];

        expect(rows.map((e) => cardLineCount(e))).toEqual([3, 5, 3]);
        expect(cardStarts(rows)).toEqual({ starts: [0, 3, 8], total: 11 });
    });

    test("truncate", () => {
        expect(truncate("abcdef", 5)).toBe("abcd…");
        expect(truncate("abc", 5)).toBe("abc");
    });
});
