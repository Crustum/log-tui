import type { Level } from "../protocol.js";
import { getTheme, type Theme } from "./theme.js";

const LEVEL_SEVERITY: Record<Level, number> = {
    debug: 100,
    info: 200,
    notice: 250,
    warning: 300,
    error: 400,
    critical: 500,
    alert: 550,
    emergency: 600,
};

export function levelColor(level: Level, theme: Theme = getTheme()): string {
    return theme.levels[level] ?? theme.text;
}

/** Active-row/modal cursor (2 cells incl. space). `»` over `▸`: the triangle
 * is missing from common console fonts; Latin-1 renders everywhere. */
export const ACTIVE_CURSOR = "» ";

export function levelSeverity(level: Level): number {
    return LEVEL_SEVERITY[level] ?? 0;
}

/** Short HH:MM:SS timestamp from float seconds. */
export function formatTs(ts: number): string {
    const d = new Date(ts * 1000);

    return d.toTimeString().slice(0, 8);
}

/** One-line summary used by the list and the --headless fallback. */
export function formatLine(source: string, ts: number, level: Level, msg: string): string {
    return `${formatTs(ts)} [${source}] ${level.toUpperCase().padEnd(9, " ")} ${msg.split("\n")[0]}`;
}
