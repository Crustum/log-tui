/** Scrollbar thumb math (multiplex `app.tsx` parity): one cell per visible row. */
export interface ThumbRange {
    /** First visible row covered by the thumb. */
    start: number;
    /** Past-the-end visible row of the thumb. */
    end: number;
    /** False when everything fits (no scrollbar). */
    show: boolean;
}

export function thumbRange(total: number, viewport: number, offset: number): ThumbRange {
    if (total <= viewport || viewport <= 0) {
        return { start: 0, end: 0, show: false };
    }

    const size = Math.max(1, Math.round((viewport / total) * viewport));
    const maxOffset = Math.max(1, total - viewport);
    const start = Math.round((Math.max(0, Math.min(maxOffset, offset)) / maxOffset) * (viewport - size));

    return { start, end: start + size, show: true };
}
