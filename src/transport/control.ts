import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

/** Env names the serve child dials back on (see PROTOCOL.md). */
export const CONTROL_PORT_ENV = "CAKE_LOGS_CONTROL_PORT";
export const CONTROL_TOKEN_ENV = "CAKE_LOGS_CONTROL_TOKEN";

/** First-line token verification — timing-safe, length-checked. */
export function verifyToken(expected: string, actual: string): boolean {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(actual, "utf8");

    if (a.length !== b.length) {
        return false;
    }

    return timingSafeEqual(a, b);
}

/**
 * Loopback control server the PHP child dials back on.
 *
 * Bulk stays on pipes; control goes over TCP because anonymous-pipe reads
 * are not selectable on Windows (blocking `fread` freezes the serve loop).
 * Unit-testable without children: `createControlServer()` only listens.
 */
export class ControlServer {
    readonly port: number;
    readonly token: string;
    private readonly server: Server;
    private active: Socket | null = null;
    private accepted: ((socket: Socket) => void)[] = [];

    private constructor(server: Server, port: number, token: string) {
        this.server = server;
        this.port = port;
        this.token = token;
        this.server.on("connection", (socket) => this.verify(socket));
    }

    static async listen(token = randomBytes(16).toString("hex")): Promise<ControlServer> {
        const server = createServer();

        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.removeListener("error", reject);
                resolve();
            });
        });

        const address = server.address();

        if (!address || typeof address === "string") {
            server.close();
            throw new Error("control server has no port");
        }

        return new ControlServer(server, address.port, token);
    }

    /** Env to inject into the serve child. */
    env(): Record<string, string> {
        return {
            [CONTROL_PORT_ENV]: String(this.port),
            [CONTROL_TOKEN_ENV]: this.token,
        };
    }

    /** Active verified socket, if the child already dialed back. */
    get socket(): Socket | null {
        return this.active && !this.active.destroyed ? this.active : null;
    }

    /** Resolves on the first verified dial-back (background accept). */
    waitForChild(timeoutMs = 10_000): Promise<Socket> {
        if (this.socket) {
            return Promise.resolve(this.socket);
        }

        return new Promise<Socket>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.accepted = this.accepted.filter((fn) => fn !== onAccept);
                reject(new Error("control dial-back timed out"));
            }, timeoutMs);

            if (timer.unref) {
                timer.unref();
            }

            const onAccept = (socket: Socket): void => {
                clearTimeout(timer);
                resolve(socket);
            };

            this.accepted.push(onAccept);
        });
    }

    /** Write one framed line to the child (no-op when not connected). */
    send(line: string): boolean {
        const socket = this.socket;

        if (!socket) {
            return false;
        }

        return socket.write(`${line}\n`);
    }

    close(): void {
        this.active?.destroy();
        this.active = null;
        this.server.close();
    }

    private verify(socket: Socket): void {
        socket.setEncoding("utf8");
        let line = "";

        const onData = (chunk: string): void => {
            line += chunk;
            const index = line.indexOf("\n");

            if (index < 0) {
                return;
            }

            const token = line.slice(0, index).replace(/\r$/, "");
            socket.removeListener("data", onData);

            if (!verifyToken(this.token, token)) {
                socket.destroy();
                return;
            }

            this.active = socket;

            for (const fn of this.accepted.splice(0)) {
                fn(socket);
            }
        };

        socket.on("data", onData);
        socket.once("error", () => {
            socket.destroy();
        });
    }
}
