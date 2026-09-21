import { spawn, type ChildProcess } from "node:child_process";
import {
    PROTOCOL_VERSION,
    encodeHostMsg,
    parseServerLine,
    type HostMsg,
    type LogEvent,
    type ReadyMsg,
    type ServerMsg,
} from "../protocol.js";
import { ControlServer } from "./control.js";
import { debugLog } from "../debug.js";

export interface CollectorEvents {
    onEvent?: (event: LogEvent) => void;
    onStatus?: (source: string, status: string) => void;
    onSourceError?: (source: string, error: string) => void;
    onDropped?: (source: string, count: number) => void;
    onBye?: (reason: string) => void;
    onExit?: (code: number | null, signal: string | null) => void;
}

export interface ConnectOptions {
    tail: number;
    sources: string[];
    /** Full shell command (launcher sets `CAKE_LOGS_SERVE_COMMAND`). */
    serveCommand?: string;
    /** Test seam: argv spawn instead of the shell string / php fallback. */
    argv?: { command: string; args: string[] };
    /** Ready handshake timeout. Default 10s. */
    timeoutMs?: number;
    events?: CollectorEvents;
}

export type CollectorFailure = "spawn" | "timeout" | "protocol";

export class CollectorError extends Error {
    constructor(
        readonly kind: CollectorFailure,
        message: string,
    ) {
        super(message);
        this.name = "CollectorError";
    }
}

const SHUTDOWN_GRACE_MS = 2000;

/**
 * Client for one `logs serve` child (PROTOCOL.md, v1).
 *
 * Spawns the PHP collector, waits for `ready` (refusing on version mismatch),
 * then dispatches server messages to `events`. The host owns all state —
 * this only moves NDJSON. Buffers are never cleared here, so `restart()`
 * preserves everything the host already holds.
 */
export class CollectorClient {
    private child: ChildProcess | null = null;
    private control: ControlServer | null = null;
    private buffer = "";
    private pending: ServerMsg[] = [];
    private readyMsg: ReadyMsg | null = null;
    private exited = false;
    private readonly events: CollectorEvents;
    private readyResolve: (() => void) | null = null;
    private closedResolve!: () => void;

    /** Resolves when the current child exits (any reason). Fresh per restart. */
    closed: Promise<void>;

    private constructor(events: CollectorEvents) {
        this.events = events;
        this.closed = new Promise<void>((resolve) => {
            this.closedResolve = resolve;
        });
    }

    /** Spawn the collector and resolve once `ready` arrives. Rejects on failure. */
    static async connect(options: ConnectOptions): Promise<CollectorClient> {
        const client = new CollectorClient(options.events ?? {});
        await client.start(options);
        return client;
    }

    /** The accepted `ready` announcement. Set after `connect()` resolves. */
    get ready(): ReadyMsg {
        if (!this.readyMsg) {
            throw new Error("collector not ready");
        }

        return this.readyMsg;
    }

    /** Live event stream. Reassignable — `connect()` resolves after `ready`, so no events are lost. */
    set onEvent(handler: ((event: LogEvent) => void) | undefined) {
        this.events.onEvent = handler;
    }

    set onDropped(handler: ((source: string, count: number) => void) | undefined) {
        this.events.onDropped = handler;
    }

    set onSourceError(handler: ((source: string, error: string) => void) | undefined) {
        this.events.onSourceError = handler;
    }

    set onStatus(handler: ((source: string, status: string) => void) | undefined) {
        this.events.onStatus = handler;
    }

    set onBye(handler: ((reason: string) => void) | undefined) {
        this.events.onBye = handler;
    }

    set onExit(handler: ((code: number | null, signal: string | null) => void) | undefined) {
        this.events.onExit = handler;
    }

    send(msg: HostMsg): void {
        const line = encodeHostMsg(msg);

        // Control socket first (selectable on every platform) — stdin
        // fallback keeps old servers and `cmd | head` debugging working.
        if (this.control?.send(line)) {
            return;
        }

        const stdin = this.child?.stdin;

        if (this.exited || !stdin || stdin.destroyed) {
            return;
        }

        stdin.write(`${line}\n`, () => {
            // EPIPE when the child died mid-write — onExit carries the news.
        });
    }

    pause(source?: string): void {
        this.send(source === undefined ? { v: 1, t: "pause" } : { v: 1, t: "pause", source });
    }

    resume(source?: string): void {
        this.send(source === undefined ? { v: 1, t: "resume" } : { v: 1, t: "resume", source });
    }

    clear(source?: string): void {
        this.send(source === undefined ? { v: 1, t: "clear" } : { v: 1, t: "clear", source });
    }

    setSources(sources: string[]): void {
        this.send({ v: 1, t: "set_sources", sources });
    }

    since(ts: number, source?: string): void {
        this.send(source === undefined ? { v: 1, t: "since", ts } : { v: 1, t: "since", source, ts });
    }

    /**
     * Restart the child, preserving host buffers. Re-runs the handshake and
     * returns the new `ready` (fresh `logConfigs`/`tabs`) for `setServerTabs`.
     */
    async restart(options: ConnectOptions): Promise<ReadyMsg> {
        await this.shutdown();
        this.buffer = "";
        this.pending = [];
        this.readyMsg = null;
        this.exited = false;
        this.closed = new Promise<void>((resolve) => {
            this.closedResolve = resolve;
        });
        await this.start(options);
        return this.ready;
    }

    /** Ask the child to exit (`shutdown`), force-killing past the grace period. */
    async shutdown(): Promise<void> {
        if (this.exited || !this.child) {
            this.control?.close();
            this.control = null;
            return;
        }

        this.send({ v: 1, t: "shutdown" });

        if (await this.waitExit(SHUTDOWN_GRACE_MS)) {
            this.control?.close();
            this.control = null;
            return;
        }

        this.kill();
        await this.waitExit(SHUTDOWN_GRACE_MS);
        this.control?.close();
        this.control = null;
    }

    /** Force-kill the child. Idempotent. */
    kill(): void {
        const child = this.child;

        if (this.exited || !child) {
            return;
        }

        try {
            child.kill();
        } catch {
            // Already gone — onExit carries the news.
        }
    }

    private async start(options: ConnectOptions): Promise<void> {
        const timeoutMs = options.timeoutMs ?? 10_000;

        // Dial-back control channel: loopback TCP is selectable on Windows,
        // anonymous pipes are not. Accept runs in the background — connect()
        // still resolves on the stdout `ready` handshake (zero latency);
        // send() routes via the socket when active, stdin otherwise.
        let control: ControlServer | null = null;

        try {
            control = await ControlServer.listen();
            void control.waitForChild(timeoutMs).catch(() => {
                // No dial-back (old server, manual run) — stdin fallback stays.
            });
        } catch {
            control = null;
        }

        this.control = control;

        let child: ChildProcess;

        try {
            child = spawnChild(options, control?.env() ?? {});
        } catch (err) {
            control?.close();
            this.control = null;
            throw new CollectorError("spawn", `could not start the collector: ${messageOf(err)}`);
        }

        this.child = child;
        this.wire(child);

        try {
            await this.handshake(child, timeoutMs);
        } catch (err) {
            this.kill();
            this.control?.close();
            this.control = null;
            throw err;
        }

        const ready = this.readyMsg;

        if (!ready || ready.v !== PROTOCOL_VERSION) {
            this.kill();
            this.control?.close();
            this.control = null;
            throw new CollectorError(
                "protocol",
                `protocol mismatch (server v${ready?.v ?? "?"}, host v${PROTOCOL_VERSION}) — update the plugin and @crustum/log-tui together.`,
            );
        }
    }

    private wire(child: ChildProcess): void {
        child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
        // stderr is piped, never inherited: the TUI owns the fullscreen, so a
        // PHP notice would scribble over the render. Drained to the debug log;
        // crashes still surface via exit code and the ready handshake.
        child.stderr?.on("data", (chunk: Buffer) => debugLog("collector stderr", chunk.toString("utf8").trimEnd()));
        child.on("exit", (code, signal) => {
            this.exited = true;
            this.closedResolve();
            this.events.onExit?.(code, signal);
        });
    }

    private handshake(child: ChildProcess, timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;

            const onError = (err: Error): void => {
                done(() =>
                    reject(
                        new CollectorError(
                            "spawn",
                            `could not start the collector (${messageOf(err)}). Use \`bin/cake logs tail\` instead — it is PHP-only and always works.`,
                        ),
                    ),
                );
            };

            const onExit = (code: number | null, signal: string | null): void => {
                done(() =>
                    reject(
                        new CollectorError(
                            "protocol",
                            `collector exited before ready (code ${code ?? "?"}, signal ${signal ?? "?"}).`,
                        ),
                    ),
                );
            };

            const done = (fn: () => void): void => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timer);
                // Handshake listeners are single-use by design — remove them so
                // repeated restarts never accumulate listeners on fresh children.
                child.removeListener("error", onError);
                child.removeListener("exit", onExit);
                fn();
            };

            const timer = setTimeout(() => {
                done(() =>
                    reject(
                        new CollectorError(
                            "timeout",
                            `collector did not send ready within ${timeoutMs}ms — is a PHP process holding the pipe?`,
                        ),
                    ),
                );
            }, timeoutMs);

            if (timer.unref) {
                timer.unref();
            }

            child.once("error", onError);
            child.once("exit", onExit);

            this.readyResolve = () => {
                done(() => resolve());
            };
        });
    }

    private onData(chunk: string): void {
        this.buffer += chunk;

        let index = this.buffer.indexOf("\n");

        while (index >= 0) {
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 1);

            // Malformed lines and unknown `t` → ignore, never crash.
            const msg = parseServerLine(line);

            if (msg !== null) {
                if (msg.t === "ready" && !this.readyMsg) {
                    this.readyMsg = msg;
                    this.readyResolve?.();
                    this.readyResolve = null;

                    // Pre-ready queue (backfill racing the handshake) replays in order.
                    for (const queued of this.pending) {
                        this.dispatch(queued);
                    }

                    this.pending = [];
                } else if (!this.readyMsg) {
                    this.pending.push(msg);
                } else {
                    this.dispatch(msg);
                }
            }

            index = this.buffer.indexOf("\n");
        }
    }

    private dispatch(msg: ServerMsg): void {
        switch (msg.t) {
            case "event":
                this.events.onEvent?.(msg);
                break;
            case "source_status":
                this.events.onStatus?.(msg.source, msg.status);
                break;
            case "source_error":
                this.events.onSourceError?.(msg.source, msg.error);
                break;
            case "dropped":
                this.events.onDropped?.(msg.source, msg.count);
                break;
            case "bye":
                this.events.onBye?.(msg.reason);
                break;
            case "ready":
                // Second ready on one pipe — treat as fresh state.
                this.readyMsg = msg;
                break;
        }
    }

    private waitExit(timeoutMs: number): Promise<boolean> {
        if (this.exited || !this.child) {
            return Promise.resolve(true);
        }

        const child = this.child;

        return new Promise<boolean>((resolve) => {
            const onExit = (): void => {
                clearTimeout(timer);
                resolve(true);
            };

            const timer = setTimeout(() => {
                child.removeListener("exit", onExit);
                resolve(false);
            }, timeoutMs);

            if (timer.unref) {
                timer.unref();
            }

            child.once("exit", onExit);
        });
    }
}

function spawnChild(options: ConnectOptions, controlEnv: Record<string, string>): ChildProcess {
    const env = { ...process.env, ...controlEnv };
    // stderr piped (see wire()): inherited stderr would corrupt the fullscreen.
    const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];

    if (options.argv) {
        return spawn(options.argv.command, options.argv.args, { stdio, env });
    }

    if (options.serveCommand) {
        return spawn(options.serveCommand, { shell: true, stdio, env });
    }

    return spawn(
        "php",
        ["bin/cake.php", "logs", "serve", `--tail=${options.tail}`, `--sources=${options.sources.join(",")}`],
        { stdio, env },
    );
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
