import { LEVELS, type Level } from "../protocol.js";
import darkJson from "./themes/dark.json" with { type: "json" };
import lightJson from "./themes/light.json" with { type: "json" };

export interface Theme {
    name: string;
    background: string;
    panel: string;
    border: string;
    text: string;
    dim: string;
    accent: string;
    /** Focus ring (selection borders). Distinct from accent (cursor/toast). */
    focus: string;
    levels: Record<Level, string>;
}

/** Raw shape of `themes/*.json` (see `schemas/log-tui-theme.schema.json`). */
export interface ThemeFile {
    name: string;
    defs?: Record<string, string>;
    theme: {
        background: string;
        panel: string;
        border: string;
        text: string;
        dim: string;
        accent: string;
        focus: string;
        levels: Record<string, string>;
    };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Resolve one theme file to a `Theme`: `defs` refs by name, hexes pass
 * through. Fail fast — bundled files are build artifacts, so a corrupt
 * file means a broken build, never a runtime fallback.
 */
export function resolveTheme(file: ThemeFile): Theme {
    const defs = file.defs ?? {};
    const resolve = (value: string, where: string): string => {
        const raw = value.startsWith("#") ? value : defs[value];

        if (raw === undefined) {
            throw new Error(`theme "${file.name}": unknown color ref "${value}" at ${where}`);
        }

        if (!HEX.test(raw)) {
            throw new Error(`theme "${file.name}": invalid hex "${raw}" at ${where}`);
        }

        return raw;
    };
    const t = file.theme;
    const levels = {} as Record<Level, string>;

    for (const level of LEVELS) {
        const value = t.levels[level];

        if (value === undefined) {
            throw new Error(`theme "${file.name}": missing level "${level}"`);
        }

        levels[level] = resolve(value, `levels.${level}`);
    }

    return {
        name: file.name,
        background: resolve(t.background, "background"),
        panel: resolve(t.panel, "panel"),
        border: resolve(t.border, "border"),
        text: resolve(t.text, "text"),
        dim: resolve(t.dim, "dim"),
        accent: resolve(t.accent, "accent"),
        focus: resolve(t.focus, "focus"),
        levels,
    };
}

export const DARK_THEME: Theme = resolveTheme(darkJson as unknown as ThemeFile);

export const LIGHT_THEME: Theme = resolveTheme(lightJson as unknown as ThemeFile);

export const THEMES: Record<string, Theme> = {
    dark: DARK_THEME,
    light: LIGHT_THEME,
} as const;

let current: Theme = DARK_THEME;

export function getTheme(): Theme {
    return current;
}

export function setTheme(name: string): Theme {
    current = THEMES[name.toLowerCase()] ?? DARK_THEME;

    return current;
}

export function toggleTheme(): Theme {
    current = current.name === "dark" ? LIGHT_THEME : DARK_THEME;

    return current;
}
