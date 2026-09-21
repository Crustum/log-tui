/** Keybinding table. Pure (no renderer import) so it stays unit-testable. */

export type KeyAction =
    | "tab:1"
    | "tab:2"
    | "tab:3"
    | "tab:4"
    | "tab:5"
    | "tab:6"
    | "tab:7"
    | "tab:8"
    | "tab:9"
    | "tab:next"
    | "tab:prev"
    | "focus:toggle"
    | "sidebar:toggle"
    | "follow:toggle"
    | "view:toggle"
    | "scroll:up"
    | "scroll:down"
    | "scroll:pageup"
    | "scroll:pagedown"
    | "scroll:top"
    | "scroll:bottom"
    | "filter:open"
    | "filter:open-tab"
    | "filter:confirm"
    | "filter:cancel"
    | "level:open"
    | "level:rotate"
    | "match:next"
    | "match:prev"
    | "clear"
    | "restart"
    | "theme:toggle"
    | "help"
    | "quit"
    | "quit:press";

export interface KeyInfo {
    name?: string;
    sequence?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
}

/**
 * Shift+letter pressed: real terminals report a lowercase `name` with the
 * `shift` flag (the legacy parser lowercases it; `sequence` keeps the raw
 * char), while the TestRenderer mock reports an uppercase `name`. Accept all
 * three forms so Shift pairs never collapse onto their lowercase action.
 */
export function isShifted(key: KeyInfo, letter: string): boolean {
    if (key.name === letter) {
        return true;
    }

    if (key.name !== letter.toLowerCase()) {
        return false;
    }

    if (key.shift === true) {
        return true;
    }

    return key.sequence === letter;
}

/**
 * Map a keypress to an action. `filterOpen` switches printable keys to
 * filter editing (handled by the caller); Enter/Escape still map here.
 */
export function keyToAction(key: KeyInfo, filterOpen: boolean): KeyAction | null {
    const name = key.name ?? "";

    if (filterOpen) {
        if (name === "return" || name === "enter") {
            return "filter:confirm";
        }

        if (name === "escape") {
            return "filter:cancel";
        }

        return null;
    }

    if (name === "q") {
        return "quit";
    }

    // First Ctrl+C copies + toasts, double Ctrl+C quits (opencode pattern):
    // the renderer must not exit natively (exitOnCtrlC: false in App).
    if (name === "c" && key.ctrl) {
        return "quit:press";
    }

    if (name === "?" || (name === "h" && key.ctrl)) {
        return "help";
    }

    if (name >= "1" && name <= "9") {
        return `tab:${name}` as KeyAction;
    }

    if (name === "tab") {
        return "focus:toggle";
    }

    if (name === "b") {
        return "sidebar:toggle";
    }

    if (name === "left") {
        return "tab:prev";
    }

    if (name === "right") {
        return "tab:next";
    }

    if (name === "up" || name === "k") {
        return "scroll:up";
    }

    if (name === "down" || name === "j") {
        return "scroll:down";
    }

    if (name === "pageup") {
        return "scroll:pageup";
    }

    if (name === "pagedown") {
        return "scroll:pagedown";
    }

    if (isShifted(key, "G") || name === "end") {
        return "scroll:bottom";
    }

    if (name === "g" || name === "home") {
        return "scroll:top";
    }

    if (name === "/") {
        return "filter:open";
    }

    if (name === "f") {
        return "filter:open-tab";
    }

    // Shift+L rotates without a modal (checked before the plain branch:
    // real terminals lowercase the name and set the shift flag instead).
    if (isShifted(key, "L")) {
        return "level:rotate";
    }

    if (name === "l") {
        return "level:open";
    }

    if (name === "s") {
        return "follow:toggle";
    }

    if (name === "v") {
        return "view:toggle";
    }

    if (name === "t") {
        return "theme:toggle";
    }

    // Shift+N selects the previous row (checked before the plain branch:
    // real terminals lowercase the name and set the shift flag instead,
    // so without this N collapses onto "next" like n).
    if (isShifted(key, "N")) {
        return "match:prev";
    }

    if (name === "n") {
        return "match:next";
    }

    if (name === "c") {
        return "clear";
    }

    if (name === "r") {
        return "restart";
    }

    // Some terminals report "/" as sequence with empty name.
    if (key.sequence === "/" && !name) {
        return "filter:open";
    }

    return null;
}

export interface HelpItem {
    keys: string;
    desc: string;
}

export interface HelpSection {
    title: string;
    items: HelpItem[];
}

/** Grouped help for the modal (hotkeys highlighted, one row per hotkey). */
export const HELP_SECTIONS: readonly HelpSection[] = [
    {
        title: "tabs",
        items: [
            { keys: "1-9", desc: "switch to tab by number" },
            { keys: "←/→", desc: "previous / next tab" },
            { keys: "Tab", desc: "focus sidebar or logs" },
        ],
    },
    {
        title: "scroll",
        items: [
            { keys: "↑↓ j/k", desc: "select row" },
            { keys: "PgUp PgDn", desc: "select one page" },
            { keys: "g G", desc: "jump to top / bottom" },
        ],
    },
    {
        title: "view",
        items: [
            { keys: "s", desc: "follow new rows on/off" },
            { keys: "v", desc: "switch lines / cards" },
            { keys: "b", desc: "show / hide sidebar" },
            { keys: "t", desc: "switch dark / light theme" },
        ],
    },
    {
        title: "filter",
        items: [
            { keys: "/", desc: "filter rows in all tabs" },
            { keys: "f", desc: "filter rows in current tab" },
            { keys: "Enter", desc: "apply the filter" },
            { keys: "Esc", desc: "clear and close filter" },
            { keys: "n N", desc: "next / previous match" },
        ],
    },
    {
        title: "level",
        items: [
            { keys: "l", desc: "pick minimum level" },
            { keys: "L", desc: "step minimum level" },
        ],
    },
    {
        title: "row",
        items: [
            { keys: "Enter", desc: "open the full event view" },
            { keys: "click", desc: "focus, then full event view" },
            { keys: "wheel", desc: "scroll the list" },
        ],
    },
    {
        title: "app",
        items: [
            { keys: "c", desc: "clear rows in current tab" },
            { keys: "r", desc: "restart the log stream" },
            { keys: "?", desc: "open this help" },
            { keys: "q", desc: "quit" },
            { keys: "^C", desc: "copy row, toast hint" },
            { keys: "^C^C", desc: "quit immediately" },
        ],
    },
] as const;

export const HELP_LINES: readonly string[] = [
    "1-9 tabs  ←/→ tabs  Tab focus sidebar/content  ↑/↓ j/k navigate/scroll",
    "PgUp/PgDn page  g/G top/bottom  s follow  v lines/cards  b sidebar",
    "/ global filter  f tab filter  Enter confirm  Esc cancel  n/N next/prev match",
    "l level filter  L rotate minimum level  c clear  r restart  t theme  ? help  q quit  ^C copy · ^C^C quit",
    "mouse: click tabs/focus · click row full view · wheel scroll",
] as const;
