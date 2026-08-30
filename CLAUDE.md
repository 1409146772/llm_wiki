# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此仓库中工作时提供指引。

## 这个项目是什么

LLM Wiki 是一个 **Tauri v2 桌面应用**（Rust 后端 + React/TypeScript 前端），它从用户的文档中构建一个持久化、由 LLM 生成的 wiki。wiki 遵循 Karpathy 的三层模式：`raw/sources/`（不可变）→ `wiki/`（LLM 生成，带 YAML frontmatter + `[[wikilinks]]`）→ `schema.md`/`purpose.md`（规则）。wiki 目录可直接作为 Obsidian vault 使用。

## 常用命令

```bash
npm run dev              # 仅前端 Vite dev server（端口 1420）
npm run tauri dev        # 完整桌面应用开发（Rust + 前端）
npm run tauri build      # 生产桌面构建
npm run typecheck        # tsc --build（仅类型检查，不产出）
npm run build            # typecheck && vite build（仅前端）

npm test                 # test:mocks + test:llm
npm run test:mocks       # vitest run，排除 *.real-llm.test.ts 和 mcp-server/**
npm run test:llm         # vitest run real-llm（需要真实 LLM/API 环境）

npm run mcp:build        # 构建内置 MCP server（tsc）
npm run mcp:test         # MCP server 测试（node --test）
```

**单个测试：** `npx vitest run src/lib/ingest-queue.test.ts`（mock 测试）——或加 `-t "test name"` 过滤。真实 LLM 测试位于 `src/lib/*.real-llm.test.ts`，**除非用环境变量开启（gate），否则会被跳过**；例如 `RUN_LLM_TESTS=1 npx vitest run src/lib/embedding.real-llm.test.ts`（需要 `EMBEDDING_ENDPOINT`/`EMBEDDING_MODEL`/`EMBEDDING_API_KEY`）。API 测试需要 `RUN_API_TESTS=1`、`API_PROJECT_ID`、`API_TOKEN`，以及应用正在运行且已开启 API。

**前置条件：** Node.js 20+、Rust 1.88+、`protoc`（仅从源码构建需要——与 MCP server 构建相关）。CI 按平台安装 protobuf；`npm --prefix mcp-server ci && npm run mcp:build` 必须在 `tauri build` 之前执行，因为 `mcp-server/dist` 会被打包为 Tauri 资源。

## 架构

### 仓库结构（四个协同组件）

- **`src/`** — React 19 + Vite + Tailwind v4 前端。三栏布局（知识树/文件树 · 聊天 · 预览），带图标侧边栏。
- **`src-tauri/`** — Rust 后端。定义所有 Tauri 命令（`lib.rs` 中的 `invoke_handler`），并托管两个内嵌服务：**本地 API**（`api_server.rs`，端口 19828）和 **网页剪辑服务**（`clip_server.rs`，端口 19827）。
- **`mcp-server/`** — 独立的 Node ESM 包。纯粹的 Model Context Protocol server，**只调用**桌面应用的本地 API `127.0.0.1:19828/api/v1`。它不重新实现 search/graph 逻辑。打包桌面应用前必须先构建（`dist/`）。
- **`extension/`** — 纯 Chrome Manifest V3 网页剪辑器（Readability.js + Turndown.js），无构建步骤。

### 前端

- **状态：Zustand。** 状态 store 在 `src/stores/`（`wiki-store` 持有项目 + LLM/embedding/search 配置；另有 `chat-store`、`review-store`、`lint-store`、`research-store` 等）。项目打开时通过这些侧边 store 从持久化文件（`src/lib/persist.ts`）完成水合。
- **业务逻辑：`src/lib/` 下的纯 TypeScript。** 这是仓库的主体。文件自包含、测试就近放置、大多与框架无关——例如 `ingest.ts`（庞大的两步链式思维摄入管线）、`ingest-queue.ts`、`dedup.ts`、`embedding.ts`、`graph-relevance.ts`、`sweep-reviews.ts`、`deep-research.ts`、`text-chunker.ts`、`source-lifecycle.ts`。前端通过 Tauri 命令调用这些逻辑。
- **Tauri 命令桥接：`src/commands/fs.ts`。** 对传入 Rust 的 `invoke()` 调用的轻量封装。路径规范化在 `src/lib/path-utils.ts`（`normalizePath` 把反斜杠换成正斜杠，处处使用）。
- **UI 基础组件**在 `src/components/ui/`（shadcn/ui）。功能组件在 `src/components/{layout,chat,graph,sources,settings,review,floating}/`。

### Rust 后端（`src-tauri/src/`）

- **命令**（`commands/`）：`fs.rs`（文件读写 + 通过 pdfium/docx-rs/calamine/anydoc 解析 PDF/DOCX/PPTX/XLSX/EPUB）、`search.rs`（关键词 + 可选向量搜索）、`file_sync.rs`（源文件夹监听）、`vectorstore.rs`（LanceDB）、`file_history.rs`、`project_maintenance.rs`（ZIP 导出/导入 + 重建索引）、`extract_images.rs`、`claude_cli.rs`/`codex_cli.rs`（子进程传输）、`ebook.rs`。
- **Agent**（`agent/`）：后端工具调用聊天运行时——`runtime.rs`（事件循环）、`tools.rs`（wiki/源码/图/网页/AnyTXT/技能工具）、`provider.rs`（LLM provider 配置）、`router.rs`、`skills.rs`、`session.rs` + `cancel.rs`。聊天由这个 agent 承载，**而不是**浏览器内的纯 TS 循环。
- **服务：** `api_server.rs`（REST，token 保护，仅回环地址）和 `clip_server.rs`（网页剪辑摄入），都基于 `tiny_http`。端口常量在 `src/lib/api-server-constants.ts`（19828）。

### 关键持久化与约定

- 项目文件：`purpose.md`、`schema.md`、`raw/sources/`、`wiki/`（`index.md`、`log.md`、`overview.md`、`entities/`、`concepts/` 等）、`.llm-wiki/`（应用配置、聊天历史、review 项、`ingest-cache.json`）、`.obsidian/`（自动生成）。
- **摄入缓存**（`src/lib/ingest-cache.ts`）：对源文件内容做 SHA256 → 未变化的文件跳过重新摄入。只有当每个先前写出的文件仍存在于磁盘上时才认可缓存命中（否则回退到完整重新摄入）。
- **LLM 任务路由**（`src/lib/llm-task-routing.ts`）：Chat 与 Ingest 的模型可独立配置，并按项目路由。
- **i18n：** 资源在 `src/i18n/*.json`（en/zh/it/ru）。新增键需要同步更新所有语言文件——`src/i18n/i18n-parity.test.ts` 强制键值一致性。
- 所有路径无论平台都用正斜杠规范化；针对 CJK 文件名使用 Unicode 安全、按字符而非字节切片。

## 测试约定

- 前端测试**就近放置**（`foo.ts` → `foo.test.ts`），用 Vitest 运行。`src/` 下有 142 个测试文件。
- 匹配 `*.real-llm.test.ts` 的文件会做真实 LLM/HTTP 调用，已从默认的 `test:mocks` 运行中排除——它们通过 `describe.skipIf(...)` 进行 gate。
- 基于属性的测试使用 `fast-check`（例如 `*.property.test.ts`）。
- 基于场景的测试复用 `src/test-helpers/scenarios/` 中的 fixture。
- Rust 没有接测试套件；CI 只检查 Rust 的 `cargo build`。
