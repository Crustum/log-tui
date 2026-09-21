import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollectorClient, type ConnectOptions } from "./collector.js";

const READY = { v: 1, t: "ready", sources: ["cake_live"], cwd: "/tmp", logConfigs: [], tabs: [] };

const QUIET = "setInterval(() => {}, 10000);";

const CHATTY = `
console.log(JSON.stringify({ v: 1, t: "event", source: "cake_live", ts: 1.5, level: "error", msg: "boom", raw: "boom", meta: {} }));
console.log("not json at all");
console.log(JSON.stringify({ v: 1, t: "mystery" }));
console.log(JSON.stringify({ v: 1, t: "dropped", source: "cake_live", count: 3 }));
${QUIET}
`;

const POLITE = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
    try {
        const msg = JSON.parse(line);
        if (msg.t === "shutdown") {
            console.log(JSON.stringify({ v: 1, t: "bye", reason: "shutdown" }));
            process.exit(0);
        }
        if (msg.t === "pause") {
            console.log(JSON.stringify({ v: 1, t: "source_status", source: msg.source ?? "*", status: "paused" }));
        }
    } catch {}
});
${QUIET}
`;

const WRONG_VERSION = `
console.log(JSON.stringify({ v: 999, t: "ready", sources: [], cwd: "/" }));
${QUIET}
`;

const dir = mkdtempSync(join(tmpdir(), "collector-test-"));
let serial = 0;
const clients: CollectorClient[] = [];

afterAll(async () => {
    for (const client of clients.splice(0)) {
        try {
            await client.shutdown();
        } catch {
            client.kill();
        }
    }

    rmSync(dir, { recursive: true, force: true });
});

/** Real stub script file (argv spawn — no shell, no eval quoting). */
function stub(handler: string, events?: ConnectOptions["events"], announce = true): ConnectOptions {
    const file = join(dir, `stub-${process.pid}-${serial++}.js`);
    const ready = announce ? `console.log(JSON.stringify(${JSON.stringify(READY)}));\n` : "";
    writeFileSync(file, `${ready}${handler}`);

    return {
        tail: 10,
        sources: ["cake_live"],
        argv: { command: process.execPath, args: [file] },
        timeoutMs: 5000,
        events,
    };
}

describe("CollectorClient", () => {
    test("handshake resolves ready and streams events, ignoring garbage", async () => {
        const events: string[] = [];
        let dropped = 0;

        const done = new Promise<void>((resolve) => {
            void CollectorClient.connect(
                stub(CHATTY, {
                    onEvent: (e) => {
                        events.push(e.msg);
                    },
                    onDropped: (_source, count) => {
                        dropped += count;
                        resolve();
                    },
                }),
            ).then((client) => {
                expect(client.ready.sources).toEqual(["cake_live"]);
                clients.push(client);
            });
        });

        await done;

        expect(events).toEqual(["boom"]);
        expect(dropped).toBe(3);
    });

    test("shutdown roundtrip delivers bye and exits", async () => {
        let bye = "";

        const client = await CollectorClient.connect(
            stub(POLITE, {
                onBye: (reason) => {
                    bye = reason;
                },
            }),
        );

        await client.shutdown();

        expect(bye).toBe("shutdown");
    });

    test("host messages reach the child", async () => {
        let status = "";

        const client = await CollectorClient.connect(
            stub(POLITE, {
                onStatus: (_source, s) => {
                    status = s;
                },
            }),
        );

        client.pause("cake_live");

        const deadline = Date.now() + 5000;

        while (status === "" && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
        }

        expect(status).toBe("paused");

        await client.shutdown();
    });

    test("silent child fails the handshake with timeout", async () => {
        await expect(CollectorClient.connect(stub(QUIET, undefined, false))).rejects.toMatchObject({
            name: "CollectorError",
            kind: "timeout",
        });
    }, 10000);

    test("wrong protocol version is refused", async () => {
        await expect(CollectorClient.connect(stub(WRONG_VERSION))).rejects.toMatchObject({
            name: "CollectorError",
            kind: "protocol",
        });
    });

    test("missing binary fails with spawn error", async () => {
        await expect(
            CollectorClient.connect({
                tail: 10,
                sources: [],
                argv: { command: "definitely-not-a-binary-xyz", args: [] },
                timeoutMs: 2000,
            }),
        ).rejects.toMatchObject({ name: "CollectorError", kind: "spawn" });
    });

    test("restart re-handshakes on a new child", async () => {
        const client = await CollectorClient.connect(stub(POLITE));
        const ready = await client.restart(stub(POLITE));

        expect(ready.sources).toEqual(["cake_live"]);

        await client.shutdown();
    });
});
