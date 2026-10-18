/**
 * Per-tab sidebar colors, multiplex parity.
 *
 * The palette is byte-for-byte the multiplex `DEFAULT_COLORS` and the
 * `ProcessColor` PHP enum (`BLUE, PURPLE, PINK, ORANGE, GREEN, YELLOW`), so a
 * `payments` stream wears the same pastel in `dev` (multiplex) and in
 * `cake dev log-tui` (sidebar). `All` (index 0) stays neutral — it is not a
 * stream.
 *
 * Pastels read well on the dark theme but wash out on near-white, so light
 * mode uses the same hues one shade deeper (600/700 ramps).
 */

export const TAB_COLORS_DARK = [
    "#93c5fd",
    "#c4b5fd",
    "#fb7185",
    "#fdba74",
    "#86efac",
    "#fcd34d",
] as const;

export const TAB_COLORS_LIGHT = [
    "#1d4ed8",
    "#7c3aed",
    "#e11d48",
    "#ea580c",
    "#15803d",
    "#b45309",
] as const;

/** Tab index → stream color. Index 0 (`All`) is neutral, hence null. */
export function tabColor(index: number, themeName = "dark"): string | null {
    if (index <= 0) {
        return null;
    }

    const palette = themeName === "light" ? TAB_COLORS_LIGHT : TAB_COLORS_DARK;

    return palette[(index - 1) % palette.length] ?? null;
}

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
];

const srgbToLinear = (channel: number) => {
    const n = channel / 255;

    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = ([r, g, b]: Rgb) =>
    0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);

// Same crossover as multiplex `contrastText`: the luminance where black and
// white text score an identical WCAG contrast ratio. Pastels keep black
// labels, deep light-mode shades get white ones.
const CONTRAST_CROSSOVER = 0.1791;

/** Black or white, whichever stays legible on the tab-color fill. */
export function contrastText(background: string): string {
    return relativeLuminance(hexToRgb(background)) > CONTRAST_CROSSOVER ? "#000000" : "#ffffff";
}
