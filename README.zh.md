# dsh-ide-context

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle：把你当前在 IDE 里的状态带进每一轮模型——打开的文件，以及当前的文本选区（文件路径、0-based 行列区间、选中文本）。

它读取 **Claude Code IDE integration** 桥——与 Claude Code CLI 相同的 `~/.claude/ide/<port>.lock` 文件与 MCP-over-WebSocket 协议——因此一个 bundle 同时支持 **IntelliJ IDEA** 与 **Visual Studio Code**。

## 安装

```sh
# 从 npm 安装
dsh plugin add dsh-ide-context

# 或直接从 git 仓库安装
dsh plugin add github:LSAI2023/dsh-ide-context
```

然后启动一个列出了该 bundle 的 profile：

```sh
dsh --profile web
```

## 配置

用户可在自己 profile 的 `cordis.patch.yml` 里覆盖任意键（它在所有 bundle 层之后应用）：

```yaml
- id: ide-context
  config:
    refreshIntervalMs: 30000  # 可选；省略或 0 表示每次状态变化都注入
    pollIntervalMs: 5000      # 可选；打开文件/选区的轮询间隔
    lockDir: ~/.claude/ide    # 可选；IDE <port>.lock 文件所在目录
```

`refreshIntervalMs` 必须是非负安全整数。省略或 `0` 表示只要 IDE 状态自上次注入以来发生变化就注入；正值会额外抑制距最近一次注入不足该毫秒数的注入。`pollIntervalMs` 默认 `5000`。`lockDir` 默认 `~/.claude/ide`。

## 模型看到什么

每当 IDE 状态变化的一轮，会有一条带来源标签的上下文消息，例如：

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

位置为 **0-based**（IntelliJ `LogicalPosition` / VS Code `Position` 语义）。

## 依赖要求

- 需要一个正在运行的 Claude Code IDE 会话，且已写出有效的 `~/.claude/ide/<port>.lock` 文件。
- 沙箱必须允许读取 `~/.claude/ide`；不允许时插件记录警告且不注入任何内容。

## 注意事项

- **单一 IDE** —— 桥只跟随最新的 lock 文件。若 IntelliJ 与 VS Code 同时打开，只跟随最新者。
- **IntelliJ 选区是推送式** —— 插件连接之前做出的选区不会回填；VS Code 额外支持轮询。
- 运行时 peer 依赖 `@deepseek-ai/dsh-llm` 与依赖 `@deepseek-ai/schemastery` 从 DeepSeek Harness 安装中解析。

## 源码

`index.js` 是编译后的插件入口。TypeScript 源码及其测试套件位于 DeepSeek Harness 仓库的 `packages/context/ide-context/`。
