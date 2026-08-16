# dsh-ide-context

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that carries what you are doing in your IDE right now into each model turn: the files currently open and the current text selection (file path, zero-based line/character range, selected text).

It reads the **Claude Code IDE integration** bridge — the same `~/.claude/ide/<port>.lock` files and MCP-over-WebSocket protocol the Claude Code CLI uses — so one bundle serves both **IntelliJ IDEA** and **Visual Studio Code**.

## Install

```sh
dsh plugin add github:LSAI2023/dsh-ide-context
```

Then boot a profile that lists this bundle:

```sh
dsh --profile web
```

## Config

Users override any key in their profile's `cordis.patch.yml` (it applies after every bundle layer):

```yaml
- id: ide-context
  config:
    refreshIntervalMs: 30000  # optional; omit or 0 to inject on every changed turn
    pollIntervalMs: 5000      # optional; how often opened files / selection are polled
    lockDir: ~/.claude/ide    # optional; where the IDE <port>.lock files live
```

`refreshIntervalMs` must be a non-negative safe integer. Omission or `0` injects whenever the IDE state changed since the last injection; a positive value additionally suppresses injections within that many milliseconds of the latest one. `pollIntervalMs` defaults to `5000`. `lockDir` defaults to `~/.claude/ide`.

## What the model sees

On each turn whose IDE state changed, one source-tagged context message like:

```text
ide context (turn 1):
ide: IntelliJ IDEA
opened files (2):
- /work/project/src/main/java/com/example/Main.java
- /work/project/pom.xml
The user selected lines 15 to 19 from /work/project/src/main/java/com/example/Main.java:
    public static void main(String[] args) {
        System.out.println("hello");
    }

This may or may not be related to the current task.
```

The selection block uses Claude Code's editor-selection structure: a 1-based inclusive line range, the selected text, and a fixed "may or may not be related" tail. Opened files are resolved by the IDE whose workspace exactly matches the session's working directory, falling back to the newest lock when none matches.

## Requirements

- A running Claude Code IDE session that has written a valid `~/.claude/ide/<port>.lock` file.
- The sandbox must permit reading `~/.claude/ide`; when it does not, the plugin logs a warning and injects nothing.

## Notes

- **Workspace matching** — the bridge prefers the IDE whose `workspaceFolders` contains the session's working directory (exact or a parent directory), then falls back to the newest lock. With both IntelliJ and VS Code open, the project you launched dsh from wins.
- **Project-scoped results** — opened files and the selection are filtered to the session's working directory and the matched IDE's `workspaceFolders`; files from unrelated projects and virtual documents (`git:`, `output:`, …) are dropped so only the current project's context is returned.
- **IntelliJ selection is push-based** — a selection made before the plugin connected is not backfilled; VS Code additionally supports polling.
- **Platforms** — native macOS and native Windows are supported (`~/.claude/ide` resolves to `C:\Users\<user>\.claude\ide` on Windows; drive letters compare case-insensitively). WSL (Linux host + Windows IDE) path/host conversion is not implemented yet.
- The runtime peer dependency `@deepseek-ai/dsh-llm` and dependency `@deepseek-ai/schemastery` resolve from the DeepSeek Harness installation.

## Development

This repository is self-contained: the TypeScript source lives in `src/` and builds to the published `index.js` (and `invariant.js`) with esbuild.

```sh
npm install         # devDependencies (esbuild, typescript, @types/node)
npm run build       # bundle src/index.ts and src/invariant.ts -> index.js / invariant.js
npm test            # live MCP-over-WebSocket smoke test against a local fake IDE bridge
```

The build keeps `@deepseek-ai/*` and `node:*` external, so the runtime dependencies resolve from the DeepSeek Harness installation exactly as before.

> `index.js` and `invariant.js` are committed build artifacts: the package is consumed directly from GitHub as compiled JS, so they must stay in sync with `src/`. After editing `src/`, run `npm run build` (or `npm run check:build` to rebuild and fail if the artifacts drift). A one-time `node install-hooks.mjs` enables a pre-commit check, and CI enforces the same guard.

## Source

The implementation is split into focused modules under `src/`:

- `src/index.ts` — assembly entry point: re-exports the public API and wires the pre-step listener.
- `src/types.ts` — domain model (`IdeSnapshot`, `IdeSelection`) and configuration schema.
- `src/constants.ts` — shared names, defaults, and tunables.
- `src/platform.ts` — path/URI handling behind a `Platform` seam (Windows-ready).
- `src/lock.ts` — lock-file discovery and workspace selection.
- `src/ws.ts` — zero-dependency RFC 6455 WebSocket client.
- `src/protocol.ts` — MCP tool-result parsing.
- `src/bridge.ts` — connection lifecycle + snapshot maintenance (`IdeBridge`).
- `src/format.ts` — snapshot rendering behind a `SelectionRenderStrategy`.
- `src/invariant.ts` — the package-owned invariant companion (registered as `@deepseek-ai/dsh-ide-context/invariant`).
- `tests/ide-context.spec.ts` — unit tests ported from the DeepSeek Harness repository's `packages/context/ide-context/`.
