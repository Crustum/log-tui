/**
 * n/N match navigation (Phase 4). The visible list is already filtered, so
 * the cursor walks the visible rows with wrap-around; the caller keeps the
 * cursor on screen by adjusting the scroll offset.
 */

/** Next cursor with wrap; 0 when the list is empty. */
export function nextMatch(current: number, total: number): number {
    if (total <= 0) {
        return 0;
    }

    return (current + 1) % total;
}

/** Previous cursor with wrap; 0 when the list is empty. */
export function prevMatch(current: number, total: number): number {
    if (total <= 0) {
        return 0;
    }

    return (current - 1 + total) % total;
}

/**
 * Scroll offset that keeps `cursor` inside `[offset, offset + viewport)`,
 * clamped to `[0, maxOffset]`. With `margin > 0` the cursor rides that many
 * rows inside the window edge instead of glued to it (readability).
 * Default 0 preserves the legacy edge behavior for existing unit tests.
 */
export function ensureVisible(
    cursor: number,
    offset: number,
    viewport: number,
    maxOffset: number,
    margin = 0,
): number {
    const m = Math.max(0, Math.min(margin, Math.max(0, Math.floor(viewport / 2))));
    let next = offset;

    if (cursor < next + m) {
        next = cursor - m;
    } else if (cursor >= next + viewport - m) {
        next = cursor - viewport + m + 1;
    }

    return Math.max(0, Math.min(maxOffset, next));
}
