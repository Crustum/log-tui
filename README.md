# @crustum/cake-logs-tui

CakePHP log viewer TUI. OpenTUI host for `bin/cake logs tui` (PHP collector over stdio).

Built with [@opentui/core](https://opentui.com)

## Requirements

- **Bun >= 1.3 or Node >= 26.4.** Native `win32-x64/arm64` prebuilds exist. Windows supported.
- Without a new-enough runtime, `bin/cake logs tui` fails fast with a message pointing at `bin/cake logs tail` (PHP-only, always works). No silent inline fallback — an unstructured dump is not this tool.

## Usage

```bash
# Fake-data shell (demo, no PHP needed)
bun src/cli.ts --fake
# or compiled:
node dist/cli.js --fake

# Prefill filters / theme from the CLI
node dist/cli.js --fake --level warning --filter 'scope=payments' --theme light

# Headless NDJSON to stdout, for pipes/tests (honours --level/--filter)
node dist/cli.js --headless --fake --tail 20 --level error | jq .

# Live mode: spawn the PHP collector (serve handshake + control channel)
node dist/cli.js --tail 200 --sources cake_live,cake_file
```

### Options

| Option | Description | Default |
| --- | --- | --- |
| `--fake` | Run the synthetic event generator (no PHP child) | `false` |
| `--tail <n>` | Backfill lines per source | `200` |
| `--sources <list>` | Comma-separated sources | `cake_live,cake_file` |
| `--headless` | NDJSON to stdout, no TUI | `false` |
| `--buffer-size <n>` | Ring-buffer lines per source | `10000` |
| `--filter <expr>` | Prefill the global filter (grammar v1) | `""` |
| `--level <level>` | Minimum level (`debug`..`emergency`, same as `logs tail --level`) | `""` |
| `--theme <name>` | Theme: `dark` or `light` | `dark` |
| `--view <mode>` | Log display: `lines` or `cards` | `lines` |

## Tabs

Tabs mirror the application's `Log` engine configs (one tab per engine), **not** files. Files overlap by design (`debug`/`all`/`error` catch the same line with different level bands), so per-file tabs would reproduce that overlap as noise.

Tab order: `All` (merged) → one per engine (in `Log::configured()` order) → raw `cake_live` / `cake_file` streams. Explicit `tabs` from `config/logs_tui.php` replace the derived defaults entirely; `All` always stays first.

Matching: live events land in an engine tab when their level and scope match the engine; file events match by file only. Overlap is faithful — two engines sharing a file both show those lines, like the files do.

## Themes

`t` switches dark / light (or `--theme light` at startup). Both themes cover the whole UI — rows, sidebar, filter box, modals and footer. The palettes live in `src/format/themes/dark.json` + `light.json` (validated against `schemas/log-tui-theme.schema.json`).

## Filter grammar v1 (JS-side, reactive)

```
expr      := or
or        := and ("||" and)*
and       := unary ("&&" unary)*
unary     := "(" expr ")" | predicate | bare-word
predicate := level (=|>=|>|<=|<) <level>
           | msg~"<sub>" | scope=<name> | file=<name>
```

Examples: `level>=warning && msg~"db"`, `scope=payments || file=error.log`, `(scope=a || scope=b) && level=error`. Anything else is a case-insensitive substring over `msg + raw + source`, so a typo never blanks the stream. `file=` is ad-hoc only — engine tabs match on sets directly (grammar `scope=` is single-match and would miss multi-scope events).

Two filter scopes: `/` edits the **global** filter (every tab), `f` edits the current **tab** filter. Both are shown in the footer. `Esc` clears the filter being edited.

Minimum severity is separate from text filters: `l` opens the level picker (`L` steps to the next minimum without a modal). The footer shows it as `lvl:warning+`; sidebar counts are unaffected.

## Views

- **Lines** (default): one row per event — `time LEVEL msg #index` (no file label; the sidebar already filters by log).
- **Cards** (`v` or `--view cards`): one `┌/│/└` card per event with header, message body and origin footer. Long queries wrap across rows instead of trimming, so every character stays visible inline.
- **Full event** (`Enter` on a row, or click a focused row): modal with the complete multi-line message plus origin/auth/context/exception sections and the raw line. Scrolls inside (`↑/↓`, wheel, `PgUp/PgDn`, `g/G`), closes with `Esc`/`Enter`. Huge events are capped so one dump cannot flood the modal.

## Keyboard shortcuts

### Navigation (left sidebar like `bin/cake dev`)

| Key | Action |
| --- | --- |
| `1`-`9` | Jump to tab (`1` = All) |
| `Tab` | Focus toggle sidebar ↔ content |
| `Left` / `Right` | Prev / next tab |
| `Up` / `Down` / `j` / `k` | Navigate tabs (sidebar focused) / scroll one line (content) |
| `PgUp` / `PgDn` | Scroll one page (content) |
| `g` / `G` | Scroll to top / bottom |
| `Enter` | Open the full event view for the selected row |
| `Esc` | Close modal / clear-and-close filter |
| Mouse click | Focus pane (first click) / open full view (click on focused row) / select tab |
| Mouse wheel | Scroll 3 lines (unfollows) |

### Actions

| Key | Action |
| --- | --- |
| `/` | Global filter edit box (framed, `Enter` confirms) |
| `f` | Current-tab filter edit box |
| `Enter` / `Esc` | Confirm / clear-and-close filter |
| `n` / `N` | Next / previous match (cursor `»`, wraps) |
| `l` | Minimum level picker (modal) |
| `L` | Step minimum level without a modal |
| `s` | Toggle follow |
| `v` | Toggle `lines` / `cards` view |
| `b` | Show / hide the sidebar |
| `c` | Clear current tab (engine/custom tabs remove matching rows across sources) |
| `r` | Restart the log stream (respawns the collector) |
| `t` | Toggle theme (dark/light) |
| `?` | Help overlay |
| `q` | Quit |
| `Ctrl+C` | Copy selection (or selected row) + toast hint |
| `Ctrl+C` again | Quit immediately |

## Footer

`FOLLOW/SCROLL[ ↓ new] · err/min N ▁▂▄ · dropped N · theme:dark · per-source counts(!badges)` + `top:` (digit/UUID-normalized repeats) + active `filter:` summary (includes `lvl:warning+` when a minimum level is set). The filter hint line shows focus-dependent bindings; copy confirmations toast there too.

## Architecture

```
src/
  cli.ts              # argv (commander), runtime check, lifecycle
  protocol.ts         # NDJSON wire types incl. ReadyMsg/logConfigs/tabs (v1)
  store/
    logs.ts           # ring buffers per source, drop-oldest + dropped badge
    counters.ts       # per source×level counts, errors/min + sparkline buckets
    filters.ts        # filter grammar v1 (||, &&, parens, level/msg/scope/file)
    levels.ts         # minimum-severity gate + rotation order
    search.ts         # n/N cursor + ensure-visible helpers
    top.ts            # top-N repeats (digit/UUID-normalized)
    engineTabs.ts     # Tab model: derived engine tabs + explicit defs + matchers
    clipboard.ts      # first-Ctrl+C copy text picker
    quitGate.ts       # double-Ctrl+C quit window
    ui.ts             # tabs, global/tab filters, scroll/focus/search state
  ui/
    App.ts            # root layout + all state transitions
    Sidebar.ts        # All → engines → raw sources, badges, focus border
    LogList.ts        # virtualized lines view, level colors, match cursor
    CardList.ts       # virtualized cards view (wraps, never trims)
    FullView.ts       # full-event modal (capped, own scroll window)
    LevelModal.ts     # minimum-level picker
    Modal.ts          # generic centered modal (backdrop + dialog)
    FilterBar.ts      # global (/) + tab (f) filter rows
    StatusBar.ts      # counters, sparkline, top-N, dropped, filters, theme
    HelpOverlay.ts    # ? overlay
    scrollbar.ts      # own thumb math (native thumbs stay hidden)
    detach.ts         # safe renderable teardown
  input/keys.ts       # keybinding table
  format/
    highlight.ts      # level severity + colors (theme-aware)
    theme.ts          # theme registry + JSON loader
    themes/           # dark.json + light.json (built-in palettes)
    cards.ts          # card shaping (header/body/footer, wrap math)
    queryPrefix.ts    # query-logger prefix expansion
  transport/
    collector.ts      # PHP child lifecycle (spawn/restart/shutdown)
    control.ts        # dial-back control channel (loopback TCP + token)
  fake.ts             # synthetic event generator + demo engine configs
```

- **Host owns ALL state** (ring buffers, filters, counters, scroll). Instant re-filter, no round-trip.
- **PHP collector is stateless**: live engine tap + file backfill → NDJSON on stdout. Never filters/counts/buffers. Custom tabs are *announced* as metadata, not sourced — routing stays in the host. Host↔collector control goes over a dial-back loopback channel (see `PROTOCOL.md`).
- **Backpressure = drop-oldest + visible `dropped` badge.** A viewer, not an audit log.
- One PHP process, sequential reader loop. No ReactPHP/AMPHP event loop in v1.

See [PROTOCOL.md](./PROTOCOL.md) for the wire format (v1).

## Development

```bash
bun install
bun run build   # tsc → dist/
bun test        # unit + TestRenderer integration tests
bun src/cli.ts --fake
```
