/**
 * Cake core SQL logger writes one line shaped
 * `connection=default role=write duration=3.2 rows=1 SELECT …`: leading
 * `key=value` attributes, then the statement. Index views (lines + cards)
 * show only the statement; the full view splits attributes onto their own
 * first line.
 */

const SQL_KEYWORDS: readonly string[] = [
    "select",
    "insert",
    "update",
    "delete",
    "replace",
    "with",
    "show",
    "describe",
    "desc",
    "explain",
    "create",
    "alter",
    "drop",
    "truncate",
    "call",
];

const PREFIX_RUN = /^((?:[A-Za-z_][\w.-]*=\S+\s+)+)(\S[\s\S]*)$/;

export interface QueryPrefix {
    /** Leading `key=value` attributes (`connection=default role=write …`). */
    attrs: string;
    /** The statement (`INSERT INTO …`). */
    sql: string;
}

/**
 * Split the first line when it carries logger attributes in front of a
 * statement. The SQL-keyword gate keeps ordinary `key=value` messages
 * untouched; a prefix without a statement is not a query line either.
 */
export function parseQueryPrefix(firstLine: string): QueryPrefix | null {
    const m = PREFIX_RUN.exec(firstLine);

    if (!m || m[1] === undefined || m[2] === undefined) {
        return null;
    }

    const keyword = /^[A-Za-z]+/.exec(m[2])?.[0].toLowerCase();

    if (!keyword || !SQL_KEYWORDS.includes(keyword)) {
        return null;
    }

    return { attrs: m[1].trim(), sql: m[2] };
}

/** Index display: statement only, attributes stripped from the first line. */
export function stripQueryPrefix(msg: string): string {
    const nl = msg.indexOf("\n");
    const head = nl === -1 ? msg : msg.slice(0, nl);
    const tail = nl === -1 ? "" : msg.slice(nl);
    const parsed = parseQueryPrefix(head);

    if (!parsed) {
        return msg;
    }

    return parsed.sql + tail;
}

/** Full-view display: attributes on their own first line, then the statement. */
export function expandQueryPrefix(msg: string): string[] {
    if (msg === "") {
        return ["No message."];
    }

    const lines = msg.split("\n");
    const parsed = parseQueryPrefix(lines[0] ?? "");

    if (!parsed) {
        return lines;
    }

    return [parsed.attrs, parsed.sql, ...lines.slice(1)];
}
