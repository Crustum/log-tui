import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { LEVELS, PROTOCOL_VERSION, type Level, type LogEvent } from "./protocol.js";
import { flattenCards, toFlatLine } from "./ui/CardList.js";
import { App } from "./ui/App.js";
import { getTheme, resolveTheme, setTheme, toggleTheme, type ThemeFile } from "./format/theme.js";
import { levelColor } from "./format/highlight.js";
import darkJson from "./format/themes/dark.json" with { type: "json" };
import lightJson from "./format/themes/light.json" with { type: "json" };

afterEach(() => {
    // theme.ts holds module-global state: never leak a test theme.
    setTheme("dark");
});

function ev(msg = "hello world, this is a log line"): LogEvent {
    return { v: PROTOCOL_VERSION, t: "event", source: "a", ts: 1726844800, level: "info", msg, raw: msg, meta: {} };
}

/** Every color reachable in a styled object. OpenTUI serializes chunk fg/bg
 * as RGBA buffers ({"fg":{"buffer":{"0":r,"1":g,"2":b,...}}}), so decode
 * those to hex alongside any literal hex strings. */
function hexesOf(value: unknown): string[] {
    const out = new Set<string>();
    const raw = JSON.stringify(value);

    for (const m of raw.matchAll(/#[0-9a-fA-F]{3,8}/g)) {
        out.add(m[0].toLowerCase());
    }

    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            for (const v of node) {
                walk(v);
            }

            return;
        }

        if (node !== null && typeof node === "object") {
            const rec = node as Record<string, unknown>;

            for (const v of Object.values(rec)) {
                const buf = (v as { buffer?: Record<string, unknown> } | null)?.buffer;

                if (buf && typeof buf[0] === "number" && typeof buf[1] === "number" && typeof buf[2] === "number") {
                    const hex = `#${[buf[0], buf[1], buf[2]]
                        .map((n) => Math.round(n as number).toString(16).padStart(2, "0"))
                        .join("")}`;
                    out.add(hex);
                } else {
                    walk(v);
                }
            }
        }
    };

    walk(JSON.parse(raw));

    return [...out].sort();
}

const DARK_SET = new Set([
    "#0b1220",
    "#101a2d",
    "#565f89",
    "#8ba6cd",
    "#3b5b82",
    "#333333",
    "#555555",
    "#666666",
    "#93c5fd",
    "#c0caf5",
    "#ffd580",
    "#f4f8ff",
    "#ffffff",
    "#888888",
    "#ff9e64",
]);

describe("theme files", () => {
    test("bundled dark/light JSON resolve to full themes", () => {
        for (const file of [darkJson, lightJson]) {
            const theme = resolveTheme(file as unknown as ThemeFile);

            expect(theme.name).toBe((file as { name: string }).name);
            for (const key of ["background", "panel", "border", "text", "dim", "accent", "focus"] as const) {
                expect(theme[key]).toMatch(/^#[0-9a-fA-F]{6}$/);
            }

            for (const level of LEVELS) {
                expect(theme.levels[level]).toMatch(/^#[0-9a-fA-F]{6}$/);
            }
        }

        expect(getTheme().name).toBe("dark");
    });

    test("loader fails fast on unknown refs, bad hexes and missing levels", () => {
        const base = structuredClone(darkJson) as unknown as ThemeFile;

        const badRef = structuredClone(base);
        badRef.theme.accent = "nope";
        expect(() => resolveTheme(badRef)).toThrow("unknown color ref");

        const badHex = structuredClone(base);
        badHex.defs = { ...(badHex.defs ?? {}), broken: "red" };
        badHex.theme.accent = "broken";
        expect(() => resolveTheme(badHex)).toThrow("invalid hex");

        const missing = structuredClone(base);
        delete (missing.theme.levels as Record<string, string>).error;
        expect(() => resolveTheme(missing)).toThrow('missing level "error"');
    });

    test("toggle flips dark/light and level colors follow", () => {
        const dark = levelColor("error");
        toggleTheme();
        expect(getTheme().name).toBe("light");
        expect(levelColor("error")).not.toBe(dark);
        expect(levelColor("unknown" as Level)).toBe(getTheme().text);
    });
});

describe("no dark leak in light mode", () => {
    test("card lines carry no dark hexes, both gutter states", () => {
        setTheme("light");
        const line = "┌ 07:27:07 INFO payments.log some message body here";

        for (const active of [true, false]) {
            const leaks = hexesOf(toFlatLine(ev(), line, active, 60)).filter((h) => DARK_SET.has(h));
            expect(leaks).toEqual([]);
        }

        const footerLeaks = hexesOf(toFlatLine(ev(), "└ GET /x • Auth: 1", false, 60)).filter((h) => DARK_SET.has(h));
        expect(footerLeaks).toEqual([]);
    });

    test("flattened cards carry no dark hexes", () => {
        setTheme("light");
        const leaks = hexesOf(flattenCards([ev()], 60, 60)).filter((h) => DARK_SET.has(h));
        expect(leaks).toEqual([]);
    });

    test("scanner is sensitive: dark theme does use the dark set", () => {
        setTheme("dark");
        const found = hexesOf(toFlatLine(ev(), "┌ 07:27:07 INFO f m", false, 40));
        expect(found.some((h) => DARK_SET.has(h))).toBe(true);
    });

    test("token mapping: gutter and thumb follow the active theme", () => {
        setTheme("light");
        const light = getTheme();
        expect(hexesOf(toFlatLine(ev(), "┌ 07:27:07 INFO f m", false, 40))).toContain(light.border);
        expect(hexesOf(toFlatLine(ev(), "┌ 07:27:07 INFO f m", true, 40))).toContain(light.accent);

        setTheme("dark");
        const dark = getTheme();
        expect(hexesOf(toFlatLine(ev(), "┌ 07:27:07 INFO f m", false, 40))).toContain(dark.border);
        expect(hexesOf(toFlatLine(ev(), "┌ 07:27:07 INFO f m", true, 40))).toContain(dark.accent);
    });
});

describe("theme toggle integration (TestRenderer)", () => {
    let setup: TestRendererSetup | null = null;
    let app: App | null = null;

    afterEach(async () => {
        if (app) {
            await app.destroy();
            app = null;
        }

        setup?.renderer.destroy();
        setup = null;
        setTheme("dark");
    });

    async function boot(theme?: string): Promise<{ setup: TestRendererSetup; app: App }> {
        const fresh = await createTestRenderer({
            width: 100,
            height: 30,
            useThread: false,
            maxFps: Number.POSITIVE_INFINITY,
            exitOnCtrlC: false,
        } as any);
        setup = fresh;
        const created = await App.create(
            { fake: false, sources: ["cake_live"], terminal: { cols: 100, rows: 30 }, ...(theme ? { theme } : {}) },
            { renderer: fresh.renderer },
        );
        app = created;
        created.ingest(ev());
        await fresh.flush();

        return { setup: fresh, app: created };
    }

    test("t toggles the theme and re-renders", async () => {
        const { setup } = await boot();
        expect(getTheme().name).toBe("dark");

        await setup.mockInput.pressKeys(["t"]);
        await setup.flush();
        expect(getTheme().name).toBe("light");

        await setup.mockInput.pressKeys(["t"]);
        await setup.flush();
        expect(getTheme().name).toBe("dark");
    });

    test("boot with light theme works", async () => {
        const { setup } = await boot("light");
        expect(getTheme().name).toBe("light");
        expect(setup.captureCharFrame()).toContain("hello world");
    });

    test("toggle while a modal is open keeps it open and repaints", async () => {
        // Note: `t` is swallowed while a modal is open (content keys are
        // hijacked), so flip the registry directly — the repaint gate in
        // App.render() covers any path that changes the theme under an open
        // modal.
        const { setup, app } = await boot();

        // Level modal open + toggle.
        await setup.mockInput.pressKeys(["l"]);
        await setup.flush();
        expect(app["levelModal"].isOpen).toBe(true);

        toggleTheme();
        app.render();
        await setup.flush();
        expect(getTheme().name).toBe("light");
        expect(app["levelModal"].isOpen).toBe(true);
        expect(setup.captureCharFrame()).toContain("minimum level");

        await setup.mockInput.pressEscape();
        await setup.flush();

        // Help overlay open + toggle.
        await setup.mockInput.pressKeys(["?"]);
        await setup.flush();
        expect(app["help"].isOpen).toBe(true);

        toggleTheme();
        app.render();
        await setup.flush();
        expect(app["help"].isOpen).toBe(true);

        // Full-view modal open + toggle.
        app.openFull(ev());
        await setup.flush();
        expect(app.fullOpen).toBe(true);

        toggleTheme();
        app.render();
        await setup.flush();
        expect(app.fullOpen).toBe(true);
    });
});
