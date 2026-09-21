import { BoxRenderable, InputRenderable, InputRenderableEvents, TextRenderable, bold, fg, t } from "@opentui/core";
import { getTheme } from "../format/theme.js";
import type { FilterTarget } from "../store/ui.js";
import { detach } from "./detach.js";

export interface FilterBarState {
    mode: FilterTarget;
    globalText: string;
    tabTitle: string;
    tabText: string;
    /** Focus-dependent bindings hint (multiplex `resolveFooter` parity). */
    focusHint: string;
    /** Transient toast (first-Ctrl+C copy): replaces the hint line, same height. */
    toast?: string;
}

/** Keep one-line hints intact on narrow terminals (filter texts can be 500 chars). */
export function shortFilterText(text: string, max = 30): string {
    const t = text.trim();

    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Filter area: a framed edit box when open (label + real `InputRenderable`
 * edit widget), a single hint/summary line when closed. Explicit heights —
 * auto-measured rows collapse to 1 and hide the label (seen in TestRenderer).
 * The input consumes printable keys natively (cursor, backspace, paste);
 * the host only syncs values via `input`/`enter` events.
 */
export class FilterBar {
    private box: BoxRenderable;
    private hint: TextRenderable;
    private label: TextRenderable;
    private input: InputRenderable;
    private opened: FilterTarget = "closed";

    onInput: ((text: string) => void) | null = null;
    onSubmit: (() => void) | null = null;

    constructor(
        renderer: any,
        parent: BoxRenderable,
    ) {
        const box = new BoxRenderable(renderer, {
            id: "filter-bar",
            flexDirection: "column",
            width: "100%",
            height: 1,
            border: false,
            borderColor: getTheme().focus,
            backgroundColor: getTheme().background,
        } as any);
        parent.add(box as any);
        this.box = box;

        this.hint = new TextRenderable(renderer, { id: "filter-hint", width: "100%", height: 1 } as any);
        box.add(this.hint as any);

        this.label = new TextRenderable(renderer, { id: "filter-label", width: "100%", height: 1 } as any);
        box.add(this.label as any);

        this.input = new InputRenderable(renderer, {
            id: "filter-input",
            width: "100%",
            backgroundColor: getTheme().panel,
            textColor: getTheme().text,
            focusedBackgroundColor: getTheme().panel,
            focusedTextColor: getTheme().text,
            placeholder: "type filter, Enter confirms, Esc clears",
            placeholderColor: getTheme().border,
            cursorColor: getTheme().accent,
            maxLength: 500,
        } as any);
        box.add(this.input as any);

        this.input.on(InputRenderableEvents.INPUT, (value: string) => {
            this.onInput?.(value);
        });
        this.input.on(InputRenderableEvents.ENTER, () => {
            this.onSubmit?.();
        });
    }

    get isOpen(): boolean {
        return this.opened !== "closed";
    }

    /** Set the edit value (emits `input`, so the host syncs back). */
    setValue(text: string): void {
        this.input.value = text;
    }

    render(state: FilterBarState): void {
        const theme = getTheme();
        const editingGlobal = state.mode === "global";

        // Input + box colors are constructor-time otherwise: re-apply every
        // frame so theme:toggle takes effect while the bar is visible.
        // Focused variants included: the widget is focused while editing and
        // renders those instead (dark defaults leaked through here).
        this.box.backgroundColor = theme.background;
        this.input.backgroundColor = theme.panel;
        this.input.textColor = theme.text;
        this.input.focusedBackgroundColor = theme.panel;
        this.input.focusedTextColor = theme.text;
        this.input.placeholderColor = theme.border;
        this.input.cursorColor = theme.accent;

        if (state.mode === "closed") {
            if (this.opened !== "closed") {
                this.input.blur();
            }

            this.opened = "closed";
            this.box.border = false;
            this.box.height = 1;
            this.hint.visible = true;
            this.label.visible = false;
            (this.input as any).visible = false;

            if (state.toast !== undefined && state.toast !== "") {
                this.hint.content = t`${fg(theme.accent)(` ${state.toast}`)}`;
                return;
            }

            const base = `/ global · f tab · ${state.focusHint}`;

            if (state.globalText === "" && state.tabText === "") {
                this.hint.content = t`${fg(theme.border)(` ${base}`)}`;
                return;
            }

            const bits: string[] = [];

            if (state.globalText !== "") {
                bits.push(`global:${shortFilterText(state.globalText)}`);
            }

            if (state.tabText !== "") {
                bits.push(`tab:${shortFilterText(state.tabText)}`);
            }

            this.hint.content = t`${fg(theme.dim)(bits.join(" "))}  ${fg(theme.border)(base)}`;

            return;
        }

        const text = editingGlobal ? state.globalText : state.tabText;

        // Visible first: focusing a hidden input loses key routing.
        this.opened = state.mode;
        this.box.border = true;
        this.box.height = 4;
        this.hint.visible = false;
        this.label.visible = true;
        (this.input as any).visible = true;
        this.label.content = editingGlobal
            ? t`${bold(fg(theme.accent)("/ global:"))}`
            : t`${bold(fg(theme.accent)(`f tab(${state.tabTitle}):`))}`;

        if (this.input.value !== text) {
            this.input.value = text;
        }

        if (!this.input.focused) {
            this.input.focus();
        }
    }

    destroy(): void {
        detach((this.box as any).parent, this.box);
        (this.box as any).destroyRecursively?.() ?? (this.box as any).destroy?.();
    }
}
