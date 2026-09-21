import { describe, expect, test } from "bun:test";
import { pickCopyText } from "./store/clipboard.js";

describe("pickCopyText", () => {
    test("mouse selection wins over the active row", () => {
        const renderer = {
            hasSelection: true,
            getSelection: () => ({ getSelectedText: () => "message 39 from other" }),
        };

        expect(pickCopyText(renderer, "active")).toEqual({ text: "message 39 from other", label: "selection" });
    });

    test("blank selection falls back to the active row", () => {
        const renderer = {
            hasSelection: true,
            getSelection: () => ({ getSelectedText: () => "   " }),
        };

        expect(pickCopyText(renderer, "active")).toEqual({ text: "active", label: "1 row" });
    });

    test("no selection copies the active row", () => {
        expect(pickCopyText({ hasSelection: false }, "active")).toEqual({ text: "active", label: "1 row" });
        expect(pickCopyText({}, "active")).toEqual({ text: "active", label: "1 row" });
        expect(pickCopyText(null, "active")).toEqual({ text: "active", label: "1 row" });
    });

    test("nothing to copy when both are empty", () => {
        expect(pickCopyText({ hasSelection: false }, null)).toBeNull();
        expect(pickCopyText({ hasSelection: false }, "")).toBeNull();
    });

    test("broken selection still falls back", () => {
        const renderer = {
            hasSelection: true,
            getSelection: () => {
                throw new Error("boom");
            },
        };

        expect(pickCopyText(renderer, "active")).toEqual({ text: "active", label: "1 row" });
    });
});
