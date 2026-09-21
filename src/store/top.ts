import type { Level, LogEvent } from "../protocol.js";

export interface TopEntry {
    /** Normalized message (digits/UUIDs collapsed). */
    key: string;
    count: number;
    /** A recent raw sample for display. */
    sample: string;
    level: Level;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMBER_RE = /\d+/g;
const SPACE_RE = /\s+/g;

/**
 * Normalize a message for repeat detection (Phase 5): UUIDs → `#uuid`,
 * digit runs → `#`, whitespace collapsed. `identical` lines with different
 * ids/counts/timings group into one entry.
 */
export function normalizeMsg(msg: string): string {
    return msg.replace(UUID_RE, "#uuid").replace(NUMBER_RE, "#").replace(SPACE_RE, " ").trim().slice(0, 160);
}

/** Top-N repeated messages, tracked per source so `clear(source)` stays honest. */
export class TopTracker {
    private perSource = new Map<string, Map<string, { count: number; sample: string; level: Level }>>();

    record(event: LogEvent): void {
        let per = this.perSource.get(event.source);

        if (!per) {
            per = new Map();
            this.perSource.set(event.source, per);
        }

        const key = `${event.level}:${normalizeMsg(event.msg)}`;
        const cur = per.get(key);

        if (cur) {
            cur.count++;
            cur.sample = event.msg;
        } else {
            per.set(key, { count: 1, sample: event.msg, level: event.level });
        }
    }

    clear(source?: string): void {
        if (source === undefined) {
            this.perSource.clear();

            return;
        }

        this.perSource.delete(source);
    }

    /** Top entries across all sources, or scoped to one source. */
    top(n: number, source?: string): TopEntry[] {
        const merged = new Map<string, { count: number; sample: string; level: Level }>();
        const scopes = source === undefined ? [...this.perSource.values()] : [this.perSource.get(source) ?? new Map()];

        for (const per of scopes) {
            for (const [key, v] of per) {
                const cur = merged.get(key);

                if (cur) {
                    cur.count += v.count;
                    cur.sample = v.sample;
                } else {
                    merged.set(key, { ...v });
                }
            }
        }

        return [...merged.entries()]
            .map(([key, v]) => ({ key, ...v }))
            .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
            .slice(0, Math.max(0, n));
    }
}
