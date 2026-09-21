export const PROTOCOL_VERSION = 1 as const;

export type Level =
    | "debug"
    | "info"
    | "notice"
    | "warning"
    | "error"
    | "critical"
    | "alert"
    | "emergency";

export const LEVELS: readonly Level[] = [
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency",
] as const;

export interface LogEvent {
    v: 1;
    t: "event";
    source: string;
    /** Float seconds, ms precision. */
    ts: number;
    level: Level;
    msg: string;
    raw: string;
    meta: Record<string, unknown>;
}

/**
 * One application `Log` engine config, as announced by `logs serve` in
 * `ready.logConfigs` (tabs plan §4). Sanitized PHP-side: name + file +
 * scopes + levels only — never `url`, never credentials. Our own
 * `dev_console_tail` engine is excluded server-side.
 */
export interface LogConfig {
    /** Engine name, e.g. "email". */
    name: string;
    /** Configured `file` as-is (host tries `file` and `file + '.log'`). */
    file: string | null;
    /** Null = all scopes. */
    scopes: string[] | null;
    /** Null = all levels, lowercase. */
    levels: string[] | null;
}

/**
 * Explicit tab definition from `config/logs_tui.php` (`DevConsole.logs.tabs`,
 * tabs plan §7). Announced as metadata in `ready.tabs` — announcing is not
 * filtering, so the stateless-collector rule still holds. `level` is a
 * *minimum* severity (same as `logs tail --level`), not an exact match.
 */
export interface TabDef {
    title: string;
    scopes?: string[];
    files?: string[];
    level?: Level;
}

export interface ReadyMsg {
    v: 1;
    t: "ready";
    sources: string[];
    cwd: string;
    /** Absent = pre-tabs server → `All` + per source fallback. */
    logConfigs?: LogConfig[];
    /** Explicit tab definitions; replace derived defaults entirely. */
    tabs?: TabDef[];
}

export type ServerMsg =
    | ReadyMsg
    | LogEvent
    | { v: 1; t: "source_status"; source: string; status: string }
    | { v: 1; t: "source_error"; source: string; error: string; retry_in?: number }
    | { v: 1; t: "dropped"; source: string; count: number }
    | { v: 1; t: "bye"; reason: string };

export type HostMsg =
    | { v: 1; t: "set_sources"; sources: string[] }
    | { v: 1; t: "pause"; source?: string }
    | { v: 1; t: "resume"; source?: string }
    | { v: 1; t: "clear"; source?: string }
    | { v: 1; t: "since"; source?: string; ts: number }
    | { v: 1; t: "shutdown" };

/**
 * Parse one NDJSON line. Returns null for unknown `t` or malformed lines —
 * the host must ignore those, never crash (PROTOCOL.md).
 */
export function parseServerLine(line: string): ServerMsg | null {
    let obj: unknown;

    try {
        obj = JSON.parse(line);
    } catch {
        return null;
    }

    if (typeof obj !== "object" || obj === null) {
        return null;
    }

    const msg = obj as Record<string, unknown>;

    if (typeof msg.t !== "string") {
        return null;
    }

    // `ready` passes through on any numeric version so the host can refuse
    // explicitly ("protocol mismatch") instead of timing out opaquely.
    // Everything else still requires v:1.
    if (msg.t !== "ready" && msg.v !== 1) {
        return null;
    }

    switch (msg.t) {
        case "ready":
        case "event":
        case "source_status":
        case "source_error":
        case "dropped":
        case "bye":
            return msg as ServerMsg;
        default:
            return null;
    }
}

export function encodeHostMsg(msg: HostMsg): string {
    return JSON.stringify(msg);
}
