/**
 * What the first Ctrl+C copies: the mouse selection when the renderer holds
 * one (non-blank), else the active row. Pure so the preference stays
 * unit-testable with stub renderers.
 */
export interface PickedText {
    text: string;
    /** Toast label: `selection` or `1 row`. */
    label: string;
}

export function pickCopyText(renderer: unknown, activeText: string | null): PickedText | null {
    try {
        const r = renderer as {
            hasSelection?: boolean;
            getSelection?: () => { getSelectedText?: () => string } | null;
        } | null;

        if (r?.hasSelection) {
            const selected = r.getSelection?.()?.getSelectedText?.() ?? "";

            if (selected.trim() !== "") {
                return { text: selected, label: "selection" };
            }
        }
    } catch {
        // A broken selection must never block the active-row fallback.
    }

    if (activeText !== null && activeText !== "") {
        return { text: activeText, label: "1 row" };
    }

    return null;
}
