import { levelSeverity } from "../format/highlight.js";
import type { Level, LogConfig, LogEvent, TabDef } from "../protocol.js";

export const LIVE_SOURCE = "cake_live";
export const FILE_SOURCE = "cake_file";

/** Display titles for the no-config fallback tabs (raw ids never reach the UI). */
const SOURCE_TITLES: Record<string, string> = {
    [LIVE_SOURCE]: "live",
    [FILE_SOURCE]: "file",
};

export type TabKind = "all" | "engine" | "custom" | "source";

export interface Tab {
    title: string;
    kind: TabKind;
    /** Set for `source` tabs. */
    source?: string;
    /** Set for `engine` tabs. */
    config?: LogConfig;
    /** Set for `custom` tabs. */
    def?: TabDef;
}

export interface TabsInput {
    sources: string[];
    /** Absent/empty = pre-tabs server or app with no engines. */
    logConfigs?: LogConfig[];
    /** Explicit definitions replace derived defaults entirely (tabs plan §7.3). */
    explicitTabs?: TabDef[];
}

/**
 * Default tab order (tabs plan §2): `All` → one per engine (in
 * `Log::configured()` order). Raw source tabs are a fallback for setups with
 * no engines at all; explicit tabs replace the derived middle section.
 * `All` always stays first.
 *
 * Engines with neither a file nor scopes (console catch-alls duplicating
 * `All`) get no tab: every record already belongs to a named logger, and the
 * channel itself is not user interface.
 */
export function buildTabs(input: TabsInput): Tab[] {
    const tabs: Tab[] = [{ title: "All", kind: "all" }];

    if (input.explicitTabs && input.explicitTabs.length > 0) {
        for (const def of input.explicitTabs) {
            tabs.push({ title: def.title, kind: "custom", def });
        }

        return tabs;
    }

    const configs = (input.logConfigs ?? []).filter((c) => c.name !== "");

    for (const config of configs) {
        if (!config.file && (config.scopes === null || config.scopes === undefined || config.scopes.length === 0)) {
            continue;
        }

        tabs.push({ title: config.name, kind: "engine", config });
    }

    if (configs.length === 0) {
        for (const source of input.sources) {
            // Raw collector ids are transport names, not log names.
            tabs.push({ title: SOURCE_TITLES[source] ?? source, kind: "source", source });
        }
    }

    return tabs;
}

/**
 * Tab matcher. Engine tabs follow tabs plan §3 exactly (approximation of
 * Cake routing, documented as such); custom tabs OR their selectors with
 * `level` as a minimum-severity AND gate. Never throws on odd meta shapes.
 */
export function matchesTab(event: LogEvent, tab: Tab): boolean {
    switch (tab.kind) {
        case "all":
            return true;
        case "source":
            return event.source === tab.source;
        case "engine":
            return tab.config ? matchesEngineTab(event, tab.config) : false;
        case "custom":
            return tab.def ? matchesCustomTab(event, tab.def) : false;
    }
}

function matchesEngineTab(event: LogEvent, config: LogConfig): boolean {
    if (event.source === FILE_SOURCE) {
        // File attribution only — no level re-gating (the engine already
        // level-filtered at write time; best-effort re-parse could misread).
        if (config.file === null || config.file === "") {
            return false;
        }

        const file = eventFile(event);

        return file !== null && (file === config.file || file === `${config.file}.log`);
    }

    // Live semantics (also used for any future non-file source): level
    // allowlist AND scope intersection. Unscoped events match engines with
    // `scopes` null only; `[]` matches unscoped-only (Cake dispatcher sense).
    if (config.levels !== null && !config.levels.map((l) => l.toLowerCase()).includes(event.level)) {
        return false;
    }

    if (config.scopes === null) {
        return true;
    }

    const scopes = eventScopes(event);

    if (config.scopes.length === 0) {
        return scopes.length === 0;
    }

    const wanted = new Set(config.scopes.map((s) => s.toLowerCase()));

    return scopes.some((s) => wanted.has(s.toLowerCase()));
}

function matchesCustomTab(event: LogEvent, def: TabDef): boolean {
    if (def.level !== undefined && levelSeverity(event.level) < levelSeverity(def.level)) {
        return false;
    }

    const wantedScopes = def.scopes ?? [];
    const wantedFiles = def.files ?? [];
    const hasScopes = wantedScopes.length > 0;
    const hasFiles = wantedFiles.length > 0;

    if (!hasScopes && !hasFiles) {
        return true;
    }

    if (hasScopes) {
        const wanted = new Set(wantedScopes.map((s) => s.toLowerCase()));

        if (eventScopes(event).some((s) => wanted.has(s.toLowerCase()))) {
            return true;
        }
    }

    if (hasFiles) {
        const file = eventFile(event);

        if (file !== null && wantedFiles.some((f) => sameFile(f, file))) {
            return true;
        }
    }

    return false;
}

/** Lenient file compare for explicit config/filters: `.log`-tolerant, case-insensitive. */
export function sameFile(a: string, b: string): boolean {
    return stripLogSuffix(a).toLowerCase() === stripLogSuffix(b).toLowerCase();
}

function stripLogSuffix(f: string): string {
    return f.toLowerCase().endsWith(".log") ? f.slice(0, -4) : f;
}

/**
 * Scopes carried by an event. Real PHP events use `meta.scopes` (list,
 * possibly empty = unscoped); the fake generator and older shapes use
 * singular `meta.scope` (string or list). Tolerates both, drops non-strings.
 */
export function eventScopes(event: LogEvent): string[] {
    const meta = event.meta as Record<string, unknown>;
    const out: string[] = [];

    const push = (v: unknown): void => {
        if (typeof v === "string" && v !== "") {
            out.push(v);
        }
    };

    const scopes = meta.scopes;

    if (Array.isArray(scopes)) {
        for (const s of scopes) {
            push(s);
        }
    }

    const scope = meta.scope;

    if (typeof scope === "string") {
        push(scope);
    } else if (Array.isArray(scope)) {
        for (const s of scope) {
            push(s);
        }
    }

    return out;
}

/** Log-file basename for file events (`meta.file`), else null. */
export function eventFile(event: LogEvent): string | null {
    const file = (event.meta as Record<string, unknown>).file;

    return typeof file === "string" && file !== "" ? file : null;
}

/** Row label: log-file basename when known, else attributed engine, else raw source. */
export function eventLabel(event: LogEvent): string {
    const file = eventFile(event);

    if (file !== null) {
        return file;
    }

    const engine = (event.meta as Record<string, unknown>).engine;

    if (typeof engine === "string" && engine !== "") {
        return engine;
    }

    return event.source;
}

/** Narrow a raw level string, else null. */
export function asLevel(s: unknown): Level | null {
    const levels: readonly string[] = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];

    if (typeof s === "string" && levels.includes(s.toLowerCase())) {
        return s.toLowerCase() as Level;
    }

    return null;
}
