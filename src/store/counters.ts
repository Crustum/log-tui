import type { Level } from "../protocol.js";
import type { LogEvent } from "../protocol.js";

/** Per source×level counts plus errors/min for the footer sparkline. */
export class Counters {
    private counts = new Map<string, Map<Level, number>>();
    private errorTs: number[] = [];

    record(event: LogEvent): void {
        let per = this.counts.get(event.source);

        if (!per) {
            per = new Map<Level, number>();
            this.counts.set(event.source, per);
        }

        per.set(event.level, (per.get(event.level) ?? 0) + 1);

        if (event.level === "error" || event.level === "critical" || event.level === "alert" || event.level === "emergency") {
            this.errorTs.push(event.ts);
        }
    }

    clear(source?: string): void {
        if (source === undefined) {
            this.counts.clear();
            this.errorTs = [];

            return;
        }

        this.counts.delete(source);
    }

    count(source: string, level: Level): number {
        return this.counts.get(source)?.get(level) ?? 0;
    }

    errorWarnCount(source: string): number {
        const per = this.counts.get(source);

        if (!per) {
            return 0;
        }

        let n = 0;

        for (const [level, c] of per) {
            if (level === "warning" || level === "error" || level === "critical" || level === "alert" || level === "emergency") {
                n += c;
            }
        }

        return n;
    }

    /** Errors in the last 60s window ending at `nowTs` (float seconds). */
    errorsPerMinute(nowTs: number): number {
        this.prune(nowTs, 60);

        return this.errorTs.length;
    }

    /**
     * Error counts per bucket over the last `buckets * bucketSecs` seconds,
     * oldest → newest — the footer sparkline data (Phase 5).
     */
    errorsSparkline(nowTs: number, buckets = 12, bucketSecs = 5): number[] {
        const window = buckets * bucketSecs;
        this.prune(nowTs, window);
        const counts = new Array<number>(buckets).fill(0);

        for (const ts of this.errorTs) {
            const age = nowTs - ts;
            const idx = buckets - 1 - Math.floor(age / bucketSecs);

            if (idx >= 0 && idx < buckets) {
                counts[idx] = (counts[idx] ?? 0) + 1;
            }
        }

        return counts;
    }

    private prune(nowTs: number, windowSecs: number): void {
        // Filter, not shift-prune: backfill can record out-of-order timestamps.
        const cutoff = nowTs - windowSecs;
        this.errorTs = this.errorTs.filter((ts) => ts >= cutoff);
    }
}

/** Render bucket counts as block-element sparkline (`▁▂▃▄▅▆▇█`). */
export function sparkline(counts: readonly number[]): string {
    const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const max = Math.max(1, ...counts);

    return counts.map((c) => blocks[Math.min(blocks.length - 1, Math.round((c / max) * (blocks.length - 1)))]).join("");
}
