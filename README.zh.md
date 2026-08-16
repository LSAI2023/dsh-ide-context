# dsh-ide-context

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle：把你当前在 IDE 里的状态带进每一轮模型——打开的文件，以及当前的文本选区（文件路径、0-based 行列区间、选中文本）。

它读取 **Claude Code IDE integration** 桥——与 Claude Code CLI 相同的 `~/.claude/ide/<port>.lock` 文件与 MCP-over-WebSocket 协议——因此一个 bundle 同时支持 **IntelliJ IDEA** 与 **Visual Studio Code**。

## 安装

```sh
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
The user selected lines 15 to 19 from /work/project/src/main/java/com/example/Main.java:
    public static void main(String[] args) {
        System.out.println("hello");
    }

This may or may not be related to the current task.
```

选区块采用 Claude Code 的编辑器选区结构：1-based 的闭区间行号、选中文本，以及一句固定的 "可能相关也可能无关" 结尾。打开的文件由 `workspaceFolders` 与当前会话工作目录**精确匹配**的那个 IDE 解析，都不匹配时回退到最新的 lock。

## 依赖要求

- 需要一个正在运行的 Claude Code IDE 会话，且已写出有效的 `~/.claude/ide/<port>.lock` 文件。
- 沙箱必须允许读取 `~/.claude/ide`；不允许时插件记录警告且不注入任何内容。

## 注意事项

- **工作区匹配** —— 桥优先选择 `workspaceFolders` 包含当前会话工作目录（精确或父目录）的那个 IDE，都不匹配时回退到最新的 lock。IntelliJ 与 VS Code 同时打开时，以你启动 dsh 所在的项目为准。
- **按项目范围过滤** —— 打开的文件与选区会过滤到会话工作目录及匹配到的 IDE 的 `workspaceFolders` 之下；无关项目的文件以及虚拟文档（`git:`、`output:` 等）会被丢弃，只返回当前项目的上下文。
- **IntelliJ 选区是推送式** —— 插件连接之前做出的选区不会回填；VS Code 额外支持轮询。
- **平台** —— 已支持原生 macOS 与原生 Windows（Windows 上 `~/.claude/ide` 解析为 `C:\Users\<user>\.claude\ide`，盘符比较不区分大小写）。WSL（Linux 宿主 + Windows IDE）的路径/主机转换尚未实现。
- 运行时 peer 依赖 `@deepseek-ai/dsh-llm` 与依赖 `@deepseek-ai/schemastery` 从 DeepSeek Harness 安装中解析。

## 开发

本仓库自包含：TypeScript 源码位于 `src/`，用 esbuild 构建到发布的 `index.js`（以及 `invariant.js`）。

```sh
npm install         # devDependencies（esbuild、typescript、@types/node）
npm run build       # 将 src/index.ts 与 src/invariant.ts 打包为 index.js / invariant.js
npm test            # 针对本地假 IDE 桥的实时 MCP-over-WebSocket 冒烟测试
```

构建会把 `@deepseek-ai/*` 与 `node:*` 保持为外部依赖，因此运行时依赖仍从 DeepSeek Harness 安装中解析，与之前一致。

> `index.js` 与 `invariant.js` 是已提交的构建产物：本包直接从 GitHub 以编译后的 JS 形式被消费，因此必须与 `src/` 保持同步。修改 `src/` 后请运行 `npm run build`（或 `npm run check:build`，它会重新构建并在产物漂移时报错）。执行一次 `node install-hooks.mjs` 可启用 pre-commit 检查，CI 亦执行同样的校验。

## 源码

实现已按职责拆分为 `src/` 下的多个模块：

- `src/index.ts` —— 装配入口：re-export 公共 API 并挂载 pre-step 监听器。
- `src/types.ts` —— 领域模型（`IdeSnapshot`、`IdeSelection`）与配置 schema。
- `src/constants.ts` —— 共享名称、默认值与可调参数。
- `src/platform.ts` —— 路径/URI 处理，置于 `Platform` 抽象之后（为 Windows 预留）。
- `src/lock.ts` —— 锁文件发现与工作区选择。
- `src/ws.ts` —— 零依赖 RFC 6455 WebSocket 客户端。
- `src/protocol.ts` —— MCP 工具结果解析。
- `src/bridge.ts` —— 连接生命周期 + 快照维护（`IdeBridge`）。
- `src/format.ts` —— 快照渲染，置于 `SelectionRenderStrategy` 之后。
- `src/invariant.ts` —— 包自有的 invariant 伴生插件（以 `@deepseek-ai/dsh-ide-context/invariant` 注册）。
- `tests/ide-context.spec.ts` —— 从 DeepSeek Harness 仓库 `packages/context/ide-context/` 移植的单元测试。
