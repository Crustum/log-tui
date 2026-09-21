import { describe, expect, test } from "bun:test";
import { QUIT_WINDOW_MS, ctrlCWantsQuit } from "./store/quitGate.js";

describe("ctrlCWantsQuit", () => {
    test("first press copies", () => {
        expect(ctrlCWantsQuit(null, 1000)).toBe(false);
    });

    test("second press inside the window quits", () => {
        expect(ctrlCWantsQuit(1000, 1000 + QUIT_WINDOW_MS - 1)).toBe(true);
    });

    test("press on the window edge still quits", () => {
        expect(ctrlCWantsQuit(1000, 1000 + QUIT_WINDOW_MS)).toBe(true);
    });

    test("press after expiry copies again", () => {
        expect(ctrlCWantsQuit(1000, 1000 + QUIT_WINDOW_MS + 1)).toBe(false);
    });
});
