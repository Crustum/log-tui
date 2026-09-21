/**
 * Double Ctrl+C gate (opencode pattern): the first press copies the visible
 * rows and toasts, the second press inside the window quits. Pure so the
 * timing edge cases stay unit-testable; `App` owns the timestamp.
 */
export const QUIT_WINDOW_MS = 1000;

/** True when this press falls inside the window of a previous one (quit). */
export function ctrlCWantsQuit(lastPress: number | null, now: number, windowMs: number = QUIT_WINDOW_MS): boolean {
    return lastPress !== null && now - lastPress <= windowMs;
}
