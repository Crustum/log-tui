import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { ControlServer, verifyToken } from "./control.js";

describe("control channel", () => {
    test("verifyToken is timing-safe and length-checked", () => {
        expect(verifyToken("abc", "abc")).toBe(true);
        expect(verifyToken("abc", "abd")).toBe(false);
        expect(verifyToken("abc", "ab")).toBe(false);
        expect(verifyToken("abc", "abcd")).toBe(false);
    });

    test("accept verifies token and routes send()", async () => {
        const control = await ControlServer.listen("s3cr3t");
        const accepted = control.waitForChild(5000);

        const child = connect(control.port, "127.0.0.1");
        child.write("s3cr3t\n");

        const socket = await accepted;
        expect(socket.destroyed).toBe(false);

        // send() delivers a framed line to the dialed-back child.
        const received = new Promise<string>((resolve) => {
            child.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
        });
        control.send('{"v":1,"t":"shutdown"}');
        expect((await received).trim()).toBe('{"v":1,"t":"shutdown"}');

        child.destroy();
        control.close();
    });

    test("mismatch destroys the socket and times out", async () => {
        const control = await ControlServer.listen("right");

        const bad = connect(control.port, "127.0.0.1");
        bad.write("wrong\n");

        await expect(control.waitForChild(500)).rejects.toThrow(/timed out/);
        expect(control.socket).toBeNull();

        bad.destroy();
        control.close();
    });
});
