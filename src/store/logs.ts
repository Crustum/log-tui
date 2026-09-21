import type { LogEvent } from "../protocol.js";

export interface DroppedInfo {
    source: string;
    count: number;
}

/**
 * Fixed-capacity ring buffer per source. Push beyond capacity drops the
 * oldest entry and reports the drop count — backpressure is drop-oldest
 * with a visible `dropped` badge, never a crash or an unbounded buffer.
 */
export class RingBuffer<T> {
    private items: T[] = [];

    constructor(readonly capacity: number) {}

    push(item: T): number {
        this.items.push(item);

        if (this.items.length > this.capacity) {
            const dropped = this.items.length - this.capacity;
            this.items.splice(0, dropped);

            return dropped;
        }

        return 0;
    }

    clear(): void {
        this.items.length = 0;
    }

    /** Remove items matching `pred`; returns the removed count. */
    removeWhere(pred: (item: T) => boolean): number {
        const before = this.items.length;
        this.items = this.items.filter((item) => !pred(item));

        return before - this.items.length;
    }

    toArray(): readonly T[] {
        return this.items;
    }

    get size(): number {
        return this.items.length;
    }
}

export class LogsStore {
    private buffers = new Map<string, RingBuffer<LogEvent>>();
    private dropped = new Map<string, number>();

    constructor(
        readonly sources: string[],
        readonly capacity = 10_000,
    ) {
        for (const s of sources) {
            this.buffers.set(s, new RingBuffer<LogEvent>(capacity));
            this.dropped.set(s, 0);
        }
    }

    push(event: LogEvent): void {
        let buf = this.buffers.get(event.source);

        if (!buf) {
            buf = new RingBuffer<LogEvent>(this.capacity);
            this.buffers.set(event.source, buf);
            this.dropped.set(event.source, 0);
        }

        const n = buf.push(event);

        if (n > 0) {
            this.dropped.set(event.source, (this.dropped.get(event.source) ?? 0) + n);
        }
    }

    recordDropped(source: string, count: number): void {
        this.dropped.set(source, (this.dropped.get(source) ?? 0) + count);
    }

    clear(source?: string): void {
        if (source === undefined) {
            for (const buf of this.buffers.values()) {
                buf.clear();
            }

            return;
        }

        this.buffers.get(source)?.clear();
    }

    /**
     * Remove events matching `pred` across all buffers (powers `c` on
     * engine/custom tabs, whose rows span sources). Returns removed count.
     */
    removeWhere(pred: (event: LogEvent) => boolean): number {
        let n = 0;

        for (const buf of this.buffers.values()) {
            n += buf.removeWhere(pred);
        }

        return n;
    }

    droppedCount(source: string): number {
        return this.dropped.get(source) ?? 0;
    }

    totalDropped(): number {
        let n = 0;

        for (const v of this.dropped.values()) {
            n += v;
        }

        return n;
    }

    forSource(source: string): readonly LogEvent[] {
        return this.buffers.get(source)?.toArray() ?? [];
    }

    /** Merged "All" view, sorted by ts (insertion is near-ordered; sort keeps tabs honest). */
    all(): LogEvent[] {
        const out: LogEvent[] = [];

        for (const buf of this.buffers.values()) {
            out.push(...buf.toArray());
        }

        out.sort((a, b) => a.ts - b.ts);

        return out;
    }
}
