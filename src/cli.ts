#!/usr/bin/env node
import { Command } from "commander";
import { debugLog, debugLogPath } from "./debug.js";
import { FakeGenerator } from "./fake.js";
import { isEmptyFilter, matchesFilter, parseFilter } from "./store/filters.js";
import { LEVELS, type Level } from "./protocol.js";
import { CollectorClient } from "./transport/collector.js";
import { App, type AppOptions } from "./ui/App.js";

const MIN_NODE = [26, 4, 0] as const;
const MIN_BUN = [1, 3, 0] as const;

function parsePositiveInt(value: string): number {
    const n = Number(value);

    if (!Number.isSafeInteger(n) || n <= 0) {
        throw new Error(`must be a positive integer, got ${value}.`);
    }

    return n;
}

function parseNonNegativeInt(value: string): number {
    const n = Number(value);

    if (!Number.isSafeInteger(n) || n < 0) {
        throw new Error(`must be a non-negative integer, got ${value}.`);
    }

    return n;
}

function runtimeOk(): boolean {
    // Bun path: process.versions.bun = "1.4.2".
    const bun = (process.versions as Record<string, string | undefined>)["bun"];

    if (bun && gte(bun, MIN_BUN)) {
        return true;
    }

    const node = process.versions.node;

    if (node && gte(node, MIN_NODE)) {
        return true;
    }

    return false;
}

function gte(version: string, min: readonly [number, number, number]): boolean {
    const parts = version.split(".").map((p) => Number(p));

    for (let i = 0; i < 3; i++) {
        const v = parts[i] ?? 0;
        if (v > min[i]) {
            return true;
        }

        if (v < min[i]) {
            return false;
        }
    }

    return true;
}

const program = new Command()
    .name("cake-logs-tui")
    .description("CakePHP log TUI host (OpenTUI). Phase 2: --fake shell, no PHP needed.")
    .option("--fake", "Run the synthetic event generator (no PHP child)", false)
    .option("--tail <n>", "Backfill lines per source (Phase 3)", parsePositiveInt, 200)
    .option("--sources <list>", "Comma-separated sources", "cake_live,cake_file")
    .option("--headless", "NDJSON to stdout, no TUI", false)
    .option("--lines <n>", "Headless serve: exit after N events (0 = run until interrupted)", parseNonNegativeInt, 0)
    .option("--buffer-size <n>", "Ring-buffer lines per source", parsePositiveInt, 10_000)
    .option("--filter <expr>", "Prefill the global filter (grammar v1)", "")
    .option("--level <level>", "Minimum level (debug..emergency)", "")
    .option("--theme <name>", "Theme: dark or light", "dark")
    .option("--view <mode>", "Log display: lines or cards", "lines")
    .parse();

const opts = program.opts<{
    fake: boolean;
    tail: number;
    sources: string;
    headless: boolean;
    lines: number;
    bufferSize: number;
    filter: string;
    level: string;
    theme: string;
    view: string;
}>();

if (opts.view !== "lines" && opts.view !== "cards") {
    program.error('error: invalid --view. Use "lines" or "cards".');
}

const sources = opts.sources
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

if (sources.length === 0) {
    program.error("error: --sources must list at least one source.");
}

/** `--level X` is a minimum severity (same as `logs tail --level`). */
function levelToFilter(level: string): string {
    const name = level.trim().toLowerCase();

    if (name === "") {
        return "";
    }

    if (!LEVELS.includes(name as Level)) {
        program.error(`error: invalid --level "${level}". Use one of: ${LEVELS.join(", ")}.`);
    }

    return `level>=${name}`;
}

/** Combined headless/TUI prefill filter: `--level` AND `--filter`. */
function combinedFilter(): string {
    const parts = [levelToFilter(opts.level), opts.filter.trim()].filter((p) => p !== "");

    return parts.join(" && ");
}

if (!runtimeOk()) {
    process.stderr.write(
        `cake-logs-tui needs Bun >= 1.3 or Node >= 26.4 (got node ${process.versions.node ?? "?"}` +
            ", bun " + ((process.versions as Record<string, string | undefined>)["bun"] ?? "none") + "). " +
            "Use `bin/cake logs tail` instead — it is PHP-only and always works.\n",
    );
    process.exit(1);
}

// Safety net first: log fatal errors to the debug file, then let the
// renderer's own handler run (it is registered later, inside App.create).
// Terminal output dies with the alternate screen — the file survives.
process.on("uncaughtException", (err) => {
    debugLog("FATAL uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
    debugLog("FATAL unhandledRejection", reason);
});

debugLog(
    "start",
    { argv: process.argv.slice(2), node: process.versions.node, bun: (process.versions as Record<string, string | undefined>)["bun"] ?? null },
    `debug-log=${debugLogPath()}`,
);

/** Spawn the collector or exit with a helpful message (never a stack trace). */
async function connectOrExit(options: { tail: number; sources: string[] }): Promise<CollectorClient> {
    debugLog("connect", { serveCommand: process.env.CAKE_LOGS_SERVE_COMMAND ?? "(fallback php bin/cake.php)" });

    try {
        const client = await CollectorClient.connect({
            tail: options.tail,
            sources: options.sources,
            serveCommand: process.env.CAKE_LOGS_SERVE_COMMAND,
        });
        debugLog("ready", {
            sources: client.ready.sources,
            engines: client.ready.logConfigs?.length ?? 0,
            tabs: client.ready.tabs?.length ?? 0,
        });
        return client;
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        debugLog("connect failed", err instanceof Error ? err : String(err));
        process.stderr.write(`could not start the log collector: ${detail}\n`);
        process.exit(1);
    }
}

// Headless modes: NDJSON to stdout for pipes/tests (no TUI, no TTY needed).
if (opts.headless) {
    const expr = parseFilter(combinedFilter());

    if (opts.fake) {
        const gen = new FakeGenerator((e) => {
            if (isEmptyFilter(expr) || matchesFilter(e, expr)) {
                process.stdout.write(`${JSON.stringify(e)}\n`);
            }
        }, sources);

        // Emit a small deterministic burst, then exit (scripting-friendly).
        for (let i = 0; i < Math.max(1, Math.min(opts.tail, 50)); i++) {
            gen.tick();
        }

        process.exit(0);
    }

    const client = await connectOrExit({ tail: opts.tail, sources });
    let count = 0;
    let done = false;

    const stop = (code: number): void => {
        if (done) {
            return;
        }

        done = true;
        void client.shutdown().finally(() => process.exit(code));
    };

    process.on("SIGINT", () => stop(0));
    process.on("SIGTERM", () => stop(0));

    client.onEvent = (e) => {
        // Gate on `done`: PHP keeps streaming until it reads our shutdown
        // (up to a tick behind), so without this the whole backfill prints.
        if (done) {
            return;
        }

        if (isEmptyFilter(expr) || matchesFilter(e, expr)) {
            process.stdout.write(`${JSON.stringify(e)}\n`);
            count++;

            if (opts.lines > 0 && count >= opts.lines) {
                stop(0);
            }
        }
    };

    await client.closed;
    process.exit(done ? 0 : 1);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("No TTY detected. Use --headless for piped output.\n");
    process.exit(1);
}

// A terminal too small for the TUI is a message, not a native crash: the
// OpenTUI renderer cannot allocate sub-window buffers (seen: 112x8) and dies
// with a native stack. Below the minimum there is no layout left to draw —
// same fallback rule as multiplex (inline output needs no room at all).
const MIN_COLS = 40;
const MIN_ROWS = 10;

function terminalSize(): { cols: number; rows: number } | null {
    const cols = process.stdout.columns ?? 0;
    const rows = process.stdout.rows ?? 0;

    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols <= 0 || rows <= 0) {
        return null;
    }

    return { cols, rows };
}

const size = terminalSize();

if (size && (size.cols < MIN_COLS || size.rows < MIN_ROWS)) {
    process.stderr.write(
        `Terminal too small (${size.cols}x${size.rows}). The log TUI needs at least ` +
            `${MIN_COLS}x${MIN_ROWS} — enlarge the window, or use \`bin/cake logs tail\` ` +
            "instead (PHP-only, always works) or --headless for piped output.\n",
    );
    process.exit(1);
}

/** Create the App, turning renderer failures into guidance instead of a native stack. */
async function createAppOrExit(options: AppOptions): Promise<App> {
    const suffix = size ? ` (terminal ${size.cols}x${size.rows})` : "";
    debugLog("App.create begin", suffix.trim() || "size unknown");

    try {
        const app = await App.create(options);
        debugLog("App.create ok");
        return app;
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        debugLog("App.create failed", err instanceof Error ? err : String(err));
        process.stderr.write(
            `Could not start the TUI${suffix}: ${detail}. Try a larger window, ` +
                "or use `bin/cake logs tail` instead — it is PHP-only and always works.\n",
        );
        process.exit(1);
    }
}

// Process control: the first interrupt shuts down gracefully (collector `shutdown`
// → `bye` → UI teardown → exit); a repeated interrupt force-kills the child.
// Handlers are registered before the child exists so it can never be orphaned.
let app: App | null = null;
let activeClient: CollectorClient | null = null;
let closing = false;

const shutdown = () => {
    if (closing) {
        debugLog("shutdown: repeated interrupt, force-kill");

        try {
            activeClient?.kill();
        } catch {
            // Already gone — just exit.
        }

        process.exit(130);
        return;
    }

    closing = true;
    debugLog("shutdown: graceful");

    const a = app;
    app = null;

    void (a ? a.destroy() : Promise.resolve()).then(() => process.exit(0));
};

process.on("SIGINT", () => {
    debugLog("signal SIGINT");
    shutdown();
});
process.on("SIGTERM", () => {
    debugLog("signal SIGTERM");
    shutdown();
});

if (opts.fake) {
    app = await createAppOrExit({
        sources,
        bufferSize: opts.bufferSize,
        fake: true,
        globalFilter: combinedFilter(),
        theme: opts.theme,
        cwd: process.cwd(),
        view: opts.view as "lines" | "cards",
    });
} else {
    // Serve mode: handshake first (tabs come from `ready`), queue anything that
    // races App creation, then hand the live child to the App.
    const pending: Array<() => void> = [];
    const client = await connectOrExit({ tail: opts.tail, sources });
    activeClient = client;

    client.onEvent = (e) => {
        if (app) {
            app.ingest(e);
        } else {
            pending.push(() => app?.ingest(e));
        }
    };
    client.onDropped = (source, count) => {
        if (app) {
            app.logs.recordDropped(source, count);
            app.render();
        } else {
            pending.push(() => {
                app?.logs.recordDropped(source, count);
                app?.render();
            });
        }
    };
    client.onSourceError = (source, error) => {
        if (app) {
            app.setNotice(`${source}: ${error}`);
        } else {
            pending.push(() => app?.setNotice(`${source}: ${error}`));
        }
    };
    client.onBye = (reason) => {
        const note = `collector said bye (${reason}) — r restarts, q quits`;

        if (app) {
            app.setNotice(note);
        } else {
            pending.push(() => app?.setNotice(note));
        }
    };
    client.onExit = (code, signal) => {
        if (closing) {
            return;
        }

        const note =
            `collector exited (code ${code ?? "?"}, signal ${signal ?? "?"}) — r restarts, q quits`;

        if (app) {
            app.setNotice(note);
        } else {
            pending.push(() => app?.setNotice(note));
        }
    };

    app = await createAppOrExit({
        sources,
        bufferSize: opts.bufferSize,
        fake: false,
        globalFilter: combinedFilter(),
        theme: opts.theme,
        cwd: client.ready.cwd ?? process.cwd(),
        view: opts.view as "lines" | "cards",
        logConfigs: client.ready.logConfigs,
        explicitTabs: client.ready.tabs,
    });

    for (const flush of pending.splice(0)) {
        flush();
    }

    app.attachCollector(client, { tail: opts.tail, sources });
}
