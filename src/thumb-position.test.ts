import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./ui/App.js";

function live(i: number) {
    return {
        v: 1 as const,
        t: "event" as const,
        source: "cake_live",
        ts: 1726844800 + i,
        level: "debug" as const,
        msg: `event number ${i} with some payload text to fill the row`,
        raw: `raw ${i}`,
        meta: { scopes: ["queriesLog"] },
    };
}

async function frameAt(view: "lines" | "cards", scrollTo: "bottom" | "middle" | "top", n: number): Promise<string> {
    const fresh = await createTestRenderer({ width: 100, height: 30, useThread: false, maxFps: Number.POSITIVE_INFINITY });
    let created: App | null = null;

    try {
        created = await App.create(
            {
                fake: false,
                sources: ["cake_live", "cake_file"],
                terminal: { cols: 100, rows: 30 },
                logConfigs: [{ name: "queries", file: "queries.log", scopes: null, levels: null }],
            },
            { renderer: fresh.renderer },
        );

        for (let i = 0; i < n; i++) {
            created.ingest(live(i));
        }

        if (view === "cards") {
            created.ui.view = "cards";
        }

        created.render();

        if (scrollTo === "top") {
            created.ui.follow = false;
            created.ui.scrollOffset = 0;
        } else if (scrollTo === "middle") {
            created.ui.follow = false;
            created.ui.scrollOffset = Math.floor(n / 2);
        }

        created.render();
        await fresh.flush();

        return fresh.captureCharFrame();
    } finally {
        await created?.destroy();
        fresh.renderer.destroy();
    }
}

describe("thumb position", () => {
    for (const view of ["lines", "cards"] as const) {
        for (const pos of ["top", "middle", "bottom"] as const) {
            test(`${view}/${pos} shows own thumb, no native bar`, async () => {
                const frame = await frameAt(view, pos, 200);
                const ours = (frame.match(/┃/g) ?? []).length;
                const native = (frame.match(/▀/g) ?? []).length;

                expect(ours).toBeGreaterThan(0);
                expect(native).toBe(0);
            });
        }
    }
});
