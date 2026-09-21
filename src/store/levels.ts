import { levelSeverity } from "../format/highlight.js";
import { LEVELS, type Level } from "../protocol.js";

/**
 * Minimum-severity filter cycle for the `L` rotate key: `all` (null) first,
 * then ascending severity, then back to `all`.
 */
export function nextMinLevel(current: Level | null): Level | null {
    if (current === null) {
        return LEVELS[0] ?? null;
    }

    const i = LEVELS.indexOf(current);

    if (i < 0 || i + 1 >= LEVELS.length) {
        return null;
    }

    return LEVELS[i + 1] ?? null;
}

/** Severity gate: keep events at or above `min` (null = all). */
export function meetsMinLevel(level: Level, min: Level | null): boolean {
    if (min === null) {
        return true;
    }

    return levelSeverity(level) >= levelSeverity(min);
}
