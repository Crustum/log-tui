import { LEVELS, type Level, type LogEvent } from "../protocol.js";
import { levelSeverity } from "../format/highlight.js";
import { eventFile, eventScopes, sameFile } from "./engineTabs.js";

export type FilterNode =
    | { kind: "all" }
    | { kind: "level"; op: "=" | ">=" | ">" | "<=" | "<"; level: Level }
    | { kind: "msg"; sub: string }
    | { kind: "scope"; scope: string }
    | { kind: "file"; file: string }
    | { kind: "text"; sub: string }
    | { kind: "and"; items: FilterNode[] }
    | { kind: "or"; items: FilterNode[] };

export interface FilterExpr {
    raw: string;
    node: FilterNode;
}

/**
 * Filter grammar v1 (Phase 4, JS-side, reactive):
 *
 *   expr    := or
 *   or      := and ("||" and)*
 *   and     := unary ("&&" unary)*
 *   unary   := "(" expr ")" | predicate | bare-word
 *   predicate := level (=|>=|>|<=|<) <level>
 *              | msg~"<sub>" | msg~'<sub>' | msg~<token>
 *              | scope=<name> | scope="<name>"
 *              | file=<name> | file="<name>"   (tabs plan §7.4, ad-hoc only)
 *
 * Anything that is not a valid predicate falls back to a case-insensitive
 * substring over `msg + raw + source` (so a typo never blanks the stream
 * and a malformed line/filter can never crash the host).
 */
export function parseFilter(raw: string): FilterExpr {
    const text = raw.trim();

    if (text === "") {
        return { raw, node: { kind: "all" } };
    }

    const node = parseOr(text);

    return { raw, node };
}

export function isEmptyFilter(expr: FilterExpr): boolean {
    return expr.node.kind === "all";
}

function parseOr(text: string): FilterNode {
    const parts = splitTopLevel(text, "||");

    if (parts.length === 1) {
        return parseAnd(parts[0] ?? text);
    }

    return { kind: "or", items: parts.map(parseAnd) };
}

function parseAnd(text: string): FilterNode {
    const parts = splitTopLevel(text, "&&");

    if (parts.length === 1) {
        return parseUnary((parts[0] ?? text).trim());
    }

    return { kind: "and", items: parts.map((p) => parseUnary(p.trim())) };
}

function parseUnary(text: string): FilterNode {
    const inner = unwrapParens(text);

    if (inner !== null) {
        return parseOr(inner);
    }

    let m = text.match(/^level\s*(>=|<=|>|<|=)\s*(\w+)\s*$/i);

    if (m && isLevel(m[2])) {
        const op = (m[1] ?? "=").toLowerCase() as "<=" | "<" | "=" | ">=" | ">";
        return { kind: "level", op, level: (m[2] ?? "debug").toLowerCase() as Level };
    }

    m = text.match(/^msg\s*~\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/);

    if (m) {
        return { kind: "msg", sub: m[1] ?? m[2] ?? m[3] ?? "" };
    }

    m = text.match(/^scope\s*=\s*(?:"([^"]+)"|'([^']+)'|([\w.-]+))\s*$/i);

    if (m) {
        return { kind: "scope", scope: m[1] ?? m[2] ?? m[3] ?? "" };
    }

    m = text.match(/^file\s*=\s*(?:"([^"]+)"|'([^']+)'|([\w.-]+))\s*$/i);

    if (m) {
        return { kind: "file", file: m[1] ?? m[2] ?? m[3] ?? "" };
    }

    // Bare word/phrase: plain substring fallback.
    const unquoted = text.match(/^"([^"]*)"$/) ?? text.match(/^'([^']*)'$/);

    return { kind: "text", sub: (unquoted?.[1] ?? text).toLowerCase() };
}

/** Split on a delimiter, ignoring occurrences inside quotes or parens. */
function splitTopLevel(text: string, delim: "&&" | "||"): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = "";

    for (let i = 0; i < text.length; i++) {
        const ch = text[i] ?? "";

        if (quote) {
            current += ch;

            if (ch === quote) {
                quote = null;
            }

            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }

        if (ch === "(") {
            depth++;
            current += ch;
            continue;
        }

        if (ch === ")") {
            depth = Math.max(0, depth - 1);
            current += ch;
            continue;
        }

        if (depth === 0 && text.startsWith(delim, i)) {
            parts.push(current);
            current = "";
            i += delim.length - 1;
            continue;
        }

        current += ch;
    }

    parts.push(current);

    return parts;
}

/** Strip one balanced outer paren pair; null when not paren-wrapped. */
function unwrapParens(text: string): string | null {
    const t = text.trim();

    if (!t.startsWith("(") || !t.endsWith(")")) {
        return null;
    }

    let depth = 0;
    let quote: string | null = null;

    for (let i = 0; i < t.length; i++) {
        const ch = t[i] ?? "";

        if (quote) {
            if (ch === quote) {
                quote = null;
            }

            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth--;

            if (depth === 0 && i < t.length - 1) {
                return null;
            }
        }
    }

    return depth === 0 ? t.slice(1, -1) : null;
}

function isLevel(s: string | undefined): boolean {
    return (LEVELS as readonly string[]).includes((s ?? "").toLowerCase());
}

export function matchesFilter(event: LogEvent, expr: FilterExpr): boolean {
    return matchesNode(event, expr.node);
}

function matchesNode(event: LogEvent, node: FilterNode): boolean {
    switch (node.kind) {
        case "all":
            return true;
        case "and":
            return node.items.every((n) => matchesNode(event, n));
        case "or":
            return node.items.some((n) => matchesNode(event, n));
        case "level":
            return compareLevel(event.level, node.op, node.level);
        case "msg":
            return event.msg.toLowerCase().includes(node.sub.toLowerCase());
        case "scope": {
            const scopes = eventScopes(event);

            return scopes.some((s) => s.toLowerCase() === node.scope.toLowerCase());
        }
        case "file": {
            const file = eventFile(event);

            return file !== null && sameFile(file, node.file);
        }
        case "text": {
            const hay = `${event.msg} ${event.raw} ${event.source}`.toLowerCase();

            return hay.includes(node.sub);
        }
    }
}

function compareLevel(actual: Level, op: "<=" | "<" | "=" | ">=" | ">", expected: Level): boolean {
    const a = levelSeverity(actual);
    const b = levelSeverity(expected);

    switch (op) {
        case "=":
            return a === b;
        case ">=":
            return a >= b;
        case ">":
            return a > b;
        case "<=":
            return a <= b;
        case "<":
            return a < b;
    }
}
