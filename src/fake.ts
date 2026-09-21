import { PROTOCOL_VERSION, type Level, type LogConfig, type LogEvent } from "./protocol.js";

const MSGS: Array<{ level: Level; msg: string; scope?: string }> = [
    { level: "debug", msg: "Query executed in 3ms", scope: "db" },
    { level: "info", msg: "GET /articles 200", scope: "request" },
    { level: "notice", msg: "Cache miss for articles.index", scope: "cache" },
    { level: "warning", msg: "Slow query: 412ms on articles", scope: "db" },
    { level: "error", msg: "DB timeout after 30s", scope: "payments" },
    { level: "info", msg: "POST /payments 201", scope: "payments" },
    { level: "debug", msg: "Auth identity resolved: user#42", scope: "auth" },
    { level: "critical", msg: "Queue worker crashed, restarting", scope: "queue" },
];

const SOURCES = ["cake_live", "cake_file"];

/**
 * Demo engine configs so the derived-tabs path (tabs plan §2) is visible
 * with zero PHP: `payments`/`db` route by scope, `errors` is a level band.
 * File attribution cycles debug/error/payments logs to show overlap.
 */
export const FAKE_LOG_CONFIGS: LogConfig[] = [
    { name: "payments", file: "payments.log", scopes: ["payments"], levels: null },
    { name: "db", file: "debug.log", scopes: ["db"], levels: null },
    { name: "errors", file: "error.log", scopes: null, levels: ["warning", "error", "critical", "alert", "emergency"] },
];

const FAKE_FILES = ["debug.log", "error.log", "payments.log"];

/**
 * Synthetic event generator for the Phase 2 shell — zero PHP needed.
 * Ticks every `intervalMs` and emits 1–3 events across the sources.
 */
export class FakeGenerator {
    private timer: ReturnType<typeof setInterval> | null = null;
    private i = 0;
    private baseTs = Date.now() / 1000;

    constructor(
        private readonly onEvent: (event: LogEvent) => void,
        readonly sources: string[] = SOURCES,
        readonly intervalMs = 350,
    ) {}

    start(): void {
        if (this.timer) {
            return;
        }

        this.timer = setInterval(() => this.tick(), this.intervalMs);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    restart(): void {
        this.stop();
        this.start();
    }

    tick(): void {
        const n = 1 + (this.i % 3 === 0 ? 1 : 0);
        for (let k = 0; k < n; k++) {
            this.onEvent(this.next());
        }
    }

    next(): LogEvent {
        const tpl = MSGS[this.i % MSGS.length] ?? { level: "info" as Level, msg: "tick" };
        const source = this.sources[this.i % this.sources.length] ?? "cake_live";
        const ts = this.baseTs + this.i * 0.35;
        this.i++;
        const meta: Record<string, unknown> = {};

        if (tpl.scope) {
            meta.scope = tpl.scope;
        }

        if (source === "cake_file") {
            // JSON-lines shape: file attribution plus scopes when known.
            meta.file = FAKE_FILES[this.i % FAKE_FILES.length] ?? "debug.log";
        }

        return {
            v: PROTOCOL_VERSION,
            t: "event",
            source,
            ts,
            level: tpl.level,
            msg: `${tpl.msg} (#${this.i})`,
            raw: `${tpl.msg} (#${this.i})`,
            meta,
        };
    }
}
