import type { LogEvent } from "../protocol.js";
import { stripQueryPrefix } from "./queryPrefix.js";

/** One log event shaped as a Phase-1 `CliPrinter` card (plain strings; styling lives in `ui/CardList`). */
export interface CardDesc {
    header: string;
    body: string[];
    footer: string;
}

const MAX_BODY_LINES = 5;

export function truncate(s: string, n: number): string {
    if (n <= 0) {
        return "";
    }

    return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

function metaRecord(ev: LogEvent): Record<string, unknown> {
    return (ev.meta ?? {}) as Record<string, unknown>;
}

function exceptionClass(ev: LogEvent): string | null {
    const ex = metaRecord(ev).exception;

    if (typeof ex === "object" && ex !== null && typeof (ex as Record<string, unknown>).class === "string") {
        const cls = (ex as Record<string, unknown>).class as string;

        return cls === "" ? null : cls;
    }

    return null;
}

function eventFile(ev: LogEvent): string | null {
    const file = metaRecord(ev).file;

    return typeof file === "string" && file !== "" ? file : null;
}

/** `guest` / `Auth: id (email)` — mirrors `CliPrinter::authLabel()`. */
export function authLabel(origin: Record<string, unknown>): string {
    const auth = origin.auth;

    if (typeof auth !== "string" && typeof auth !== "number") {
        return "guest";
    }

    let label = `Auth: ${String(auth)}`;
    const email = origin.auth_email;

    if (typeof email === "string" && email !== "") {
        label += ` (${email})`;
    }

    return label;
}

/** `METHOD path` / `console: cmd` / null — mirrors `CliPrinter::footer()` origin half. */
export function originLabel(origin: Record<string, unknown>): string | null {
    if (origin.type === "http") {
        const method = typeof origin.method === "string" ? origin.method : "";
        const path = typeof origin.path === "string" ? origin.path : "";

        if (method !== "" || path !== "") {
            return `${method} ${path}`.trim();
        }

        return null;
    }

    if (typeof origin.command === "string" && origin.command !== "") {
        return `console: ${origin.command}`;
    }

    return null;
}

function formatValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

/** Footer parts: origin (+ auth for http) then `k: v` context pairs — mirrors `CliPrinter::footer()`. */
export function cardFooterParts(ev: LogEvent): string[] {
    const parts: string[] = [];
    const meta = metaRecord(ev);
    const originRaw = meta.origin;
    const origin: Record<string, unknown> =
        typeof originRaw === "object" && originRaw !== null ? (originRaw as Record<string, unknown>) : {};

    const originText = originLabel(origin);

    if (originText !== null) {
        parts.push(originText);
    }

    // Console origins carry no auth half (mirrors CliPrinter).
    if (origin.type === "http") {
        parts.push(authLabel(origin));
    }

    const context = meta.context;

    if (typeof context === "object" && context !== null) {
        for (const [key, value] of Object.entries(context as Record<string, unknown>)) {
            parts.push(`${key}: ${formatValue(value)}`);
        }
    }

    return parts;
}

/** Body lines: message split, capped at 5. Width wrap happens later
 * (`renderCardWrapped`) so long queries stay fully visible inline;
 * `MAX_BODY_LINES` stays as the multi-KB guard, the full text lives
 * in the full-view modal. */
export function cardBodyLines(ev: LogEvent, width?: number): string[] {
    void width;
    if (ev.msg === "") {
        return ["No message."];
    }

    // Query-logger attributes stay in the full view; cards show the statement.
    return stripQueryPrefix(ev.msg).split("\n").slice(0, MAX_BODY_LINES);
}

/** Full card description; `width` = usable body width (pane minus `│ ` prefix and border). */
export function describeCard(ev: LogEvent, width: number): CardDesc {
    const cls = exceptionClass(ev);
    const file = eventFile(ev);
    const header = `${formatClock(ev.ts)} ${ev.level.toUpperCase()}${cls ? ` ${cls}` : ""}${file ? ` ${truncate(file, Math.max(10, width))}` : ""}`;
    const body = cardBodyLines(ev, width);
    const parts = cardFooterParts(ev);

    return { header, body, footer: parts.join(" • ") };
}

/** Plain-text card with `┌/│/└` prefixes (matches the Phase-1 sample). */
export function renderCard(desc: CardDesc): string[] {
    return [`┌ ${desc.header}`, ...desc.body.map((line) => `│ ${line}`), desc.footer !== "" ? `└ ${desc.footer}` : "└"];
}

/**
 * Split one prefixed card line into screen-row segments that each fit
 * `width` cells. The first segment keeps its `┌/│/└` cap; continuations use
 * the `│ ` prefix so the card shape stays readable.
 */
export function wrapCardLine(line: string, width: number): string[] {
    const w = Math.max(4, Math.floor(width));
    if (line.length <= w) {
        return [line];
    }
    const out: string[] = [line.slice(0, w)];
    let rest = line.slice(w);
    const step = Math.max(1, w - 2);
    while (rest.length > 0) {
        out.push(`│ ${rest.slice(0, step)}`);
        rest = rest.slice(step);
    }
    return out;
}

/** `renderCard` + width wrap: every character stays visible. */
export function renderCardWrapped(desc: CardDesc, width?: number): string[] {
    const lines = renderCard(desc);
    if (width === undefined || width <= 0) {
        return lines;
    }
    return lines.flatMap((line) => wrapCardLine(line, width));
}

/**
 * Screen rows one event occupies. Width-aware when both widths are given
 * (wrapped screen rows); otherwise the logical count (body + header +
 * footer) so cheap scroll math keeps working.
 */
export function cardLineCount(ev: LogEvent, bodyWidth?: number, lineWidth?: number): number {
    if (bodyWidth === undefined || lineWidth === undefined) {
        const body = ev.msg === "" ? 1 : Math.min(MAX_BODY_LINES, ev.msg.split("\n").length);
        return body + 2;
    }
    return renderCardWrapped(describeCard(ev, bodyWidth), effectiveWrapWidth(lineWidth)).length;
}

/** Line offset where each card starts (prefix sums); total = last start + last count. */
export function cardStarts(
    rows: readonly LogEvent[],
    bodyWidth?: number,
    lineWidth?: number,
): { starts: number[]; total: number } {
    const starts: number[] = [];
    let total = 0;

    for (const ev of rows) {
        starts.push(total);
        total += cardLineCount(ev, bodyWidth, lineWidth);
    }

    return { starts, total };
}

/** Row budget minus the 2-cell active cursor so wrapped rows never clip. */
export function effectiveWrapWidth(lineWidth: number): number {
    return Math.max(4, Math.floor(lineWidth) - 2);
}

/** `HH:MM:SS` clock for card headers (local time, like `formatTs`). */
export function formatClock(ts: number): string {
    return new Date(ts * 1000).toTimeString().slice(0, 8);
}
