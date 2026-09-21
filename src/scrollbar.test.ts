import { describe, expect, test } from "bun:test";
import { thumbRange } from "./ui/scrollbar.js";

describe("thumbRange", () => {
    test("hidden when everything fits", () => {
        expect(thumbRange(10, 20, 0).show).toBe(false);
        expect(thumbRange(20, 20, 0).show).toBe(false);
    });

    test("thumb sits at the bottom when followed", () => {
        const total = 40;
        const vp = 20;
        const max = total - vp;
        const thumb = thumbRange(total, vp, max);

        expect(thumb.show).toBe(true);
        expect(thumb.end).toBe(vp);
    });

    test("thumb sits at the top when scrolled up", () => {
        const thumb = thumbRange(40, 20, 0);

        expect(thumb.show).toBe(true);
        expect(thumb.start).toBe(0);
        expect(thumb.end).toBeLessThan(20);
    });

    test("thumb moves monotonically with the offset", () => {
        const starts = [0, 5, 10, 15, 20].map((off) => thumbRange(40, 20, off).start);

        expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    });
});
