# Cake Log TUI wire protocol — v1 (draft, frozen in Phase 6)

NDJSON, one object per line, `v` on every message. Unknown `t` → ignore; malformed line → ignore, never crash.

## Server → host (PHP `logs serve` stdout)

```ts
type ServerMsg =
    | { v: 1; t: "ready"; sources: string[]; cwd: string; logConfigs: LogConfig[]; tabs: TabDef[] }
    | { v: 1; t: "event"; source: string; ts: number; level: Level; msg: string; raw: string; meta: Record<string, unknown> }
    | { v: 1; t: "source_status"; source: string; status: string }
    | { v: 1; t: "source_error"; source: string; error: string; retry_in?: number }
    | { v: 1; t: "dropped"; source: string; count: number }
    | { v: 1; t: "bye"; reason: string };

/** One app.php Log engine, sanitized (no url/className/credentials). null = no constraint. */
interface LogConfig {
    name: string;
    file: string | null;
    scopes: string[] | null;
    levels: string[] | null;
}

/**
 * Explicit tab from DevConsole.logs.tabs config. level = minimum severity
 * (same as `logs tail --level`). Empty list = none configured.
 */
interface TabDef {
    title: string;
    scopes?: string[];
    files?: string[];
    level?: Level;
}
```

- `event.ts` = float seconds, ms precision.
- `level` ∈ `debug|info|notice|warning|error|critical|alert|emergency`.
- `meta` = free-form (scope, request, auth, file/line, trace). `raw` = original line for unparseable fallback.
- `cake_live` events carry `meta.engine` + `meta.file` (log basename) when the
  record attributes to one configured engine (level allowlist AND scope
  intersection, scoped engines beat catch-alls); otherwise the host falls back
  to the raw source name. Row labels render `meta.file ?? meta.engine ?? source`.
- v1 sources: `cake_live` (engine tap: every record, live only) + `cake_file`
  (existing `LOGS/*.log` read once as start-up history, best-effort parse).
  After the backfill the host streams live only, so records never duplicate;
  replays on the start-up boundary are suppressed server-side.
- Sentry webhook/API, syslog UDP, DB poll, SSH remote: explicitly OUT (protocol keeps them possible later).

## Host → server (PHP `logs serve` stdin)

```ts
type HostMsg =
    | { v: 1; t: "set_sources"; sources: string[] }
    | { v: 1; t: "pause"; source?: string }
    | { v: 1; t: "resume"; source?: string }
    | { v: 1; t: "clear"; source?: string }
    | { v: 1; t: "since"; source?: string; ts: number }
    | { v: 1; t: "shutdown" };
```

## Spawning (contract with `bin/cake logs tui`)

The host spawns the collector as a child: stdin/stdout pipes (the protocol above),
stderr piped to the host debug log (`CAKE_LOGS_TUI_DEBUG=1`, never the terminal —
inherited stderr would scribble over the fullscreen). Serve invocation comes from `CAKE_LOGS_SERVE_COMMAND` env
(set by the launcher, e.g. `php "…/bin/cake.php" logs serve --tail=200
--sources=cake_live,cake_file`); fallback when unset is
`php bin/cake.php logs serve` with the host's own `--tail`/`--sources` values.

## Control channel (dial-back, no version bump)

Bulk stays on pipes; host→server control moves to loopback TCP because
anonymous-pipe reads are not selectable on Windows (blocking `fread` freezes
the serve poll loop). Same shape as `amphp/process` `ProcessWrapper64.exe`
(sockets + tokens), but the parent is Node so no wrapper binary is needed.

- Host opens `127.0.0.1:0` + random 16-byte hex token, injects
  `CAKE_LOGS_CONTROL_PORT` / `CAKE_LOGS_CONTROL_TOKEN` into every spawn path
  (shell string, `argv` seam, php fallback).
- Serve dials `tcp://127.0.0.1:PORT`, sends `token\n` first, sets non-blocking.
  No env / dial fails → legacy stdin polling (manual `cmd | head` + old hosts keep working).
- Host verifies the first line timing-safe; mismatch → destroy socket.
  Accept runs in background — `connect()` still resolves on stdout `ready`
  (zero latency); `send()` routes control-socket-first, stdin otherwise.
- Serve paces file polling on `stream_select([control], …, 100ms)`; complete
  lines go through the same `ServeHost::apply` path as stdin. Control EOF →
  `bye {reason: control-closed}`. `restart()` = new server + token + respawn;
  `shutdown()` prefers the socket, kill fallback stays.

## Rules

1. Host owns state. No filters/counters/buffers in PHP.
2. No new protocol fields without a version bump (`"v":1` in `ready`; host refuses on mismatch).
   Exception while the protocol is draft (frozen in Phase 6): `ready` gained `logConfigs` + `tabs`
   (tab *definitions* for the host to render — announcing is metadata, not filtering, so the
   collector stays stateless; sources remain exactly `cake_live` + `cake_file`).
3. Backpressure = drop-oldest + `dropped` message.
4. Tab precedence (host-side): explicit `tabs` > derived from `logConfigs` > `All` + per source.
   Missing `logConfigs`/`tabs` (older servers) = fall back to `All` + per source.
