# dsh-ide-context

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that carries what you are doing in your IDE right now into each model turn: the files currently open and the current text selection (file path, zero-based line/character range, selected text).

It reads the **Claude Code IDE integration** bridge — the same `~/.claude/ide/<port>.lock` files and MCP-over-WebSocket protocol the Claude Code CLI uses — so one bundle serves both **IntelliJ IDEA** and **Visual Studio Code**.

## Install

```sh
# from npm
dsh plugin add dsh-ide-context

# or straight from a git host
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
selection: /work/project/src/main/java/com/example/Main.java 14:0 - 18:1
    public static void main(String[] args) {
        System.out.println("hello");
    }
```

Positions are **zero-based** (IntelliJ `LogicalPosition` / VS Code `Position` semantics).

## Requirements

- A running Claude Code IDE session that has written a valid `~/.claude/ide/<port>.lock` file.
- The sandbox must permit reading `~/.claude/ide`; when it does not, the plugin logs a warning and injects nothing.

## Notes

- **Single IDE** — the bridge follows the newest lock file. If both IntelliJ and VS Code are open, only the newest is followed.
- **IntelliJ selection is push-based** — a selection made before the plugin connected is not backfilled; VS Code additionally supports polling.
- The runtime peer dependency `@deepseek-ai/dsh-llm` and dependency `@deepseek-ai/schemastery` resolve from the DeepSeek Harness installation.

## Source

`index.js` is the transpiled plugin entry. The TypeScript source and its test suite live in the DeepSeek Harness repository under `packages/context/ide-context/`.
