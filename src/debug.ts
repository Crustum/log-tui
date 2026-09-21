import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG_FILE = join(tmpdir(), "cake-logs-tui-debug.log");

/**
 * File debug log, gated by `CAKE_LOGS_TUI_DEBUG=1`.
 *
 * Startup/shutdown diagnostics go here (not stderr): the TUI runs in the
 * alternate screen, so anything printed to the terminal is wiped when the app
 * dies — a file survives. Timestamps every line; never throws.
 */
export function debugLog(...parts: unknown[]): void {
    if (process.env.CAKE_LOGS_TUI_DEBUG !== "1") {
        return;
    }

    const line = `[${new Date().toISOString()}] ${parts.map((p) => safeString(p)).join(" ")}\n`;

    try {
        appendFileSync(LOG_FILE, line, "utf8");
    } catch {
        // Diagnostics must never break the host.
    }
}

/** Absolute path of the debug log (for pointing users at it). */
export function debugLogPath(): string {
    return LOG_FILE;
}

function safeString(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (value instanceof Error) {
        return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
    }

    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}
