# Jira 功能学习指南（新手版）

> 本文基于仓库中两次提交（`4980d19`、`ccba952`，分支 `dev_JIRA_LZY`）新增的 Jira 集成代码写成，
> 目标是让没接触过桌面开发 / 前端工程化的同学也能看懂：**用了什么技术、代码怎么分层、
> 怎么开发、怎么测试、怎么编译打包**。

---

## 目录

1. [先搞清楚：这个项目到底是什么](#1-先搞清楚这个项目到底是什么)
2. [Jira 功能用到的技术栈](#2-jira-功能用到的技术栈)
3. [代码架构：九个文件各管一件事](#3-代码架构九个文件各管一件事)
4. [数据是怎么流动的（完整链路）](#4-数据是怎么流动的完整链路)
5. [开发流程：这个功能是怎么一步步做出来的](#5-开发流程这个功能是怎么一步步做出来的)
6. [开发环境搭建](#6-开发环境搭建)
7. [编译与构建：有哪些方式，都干了什么](#7-编译与构建有哪些方式都干了什么)
8. [测试是怎么做的](#8-测试是怎么做的)
9. [日常工作流（记住这个循环）](#9-日常工作流记住这个循环)
10. [新手读代码顺序建议](#10-新手读代码顺序建议)
11. [附录：名词小词典](#11-附录名词小词典)

---

## 1. 先搞清楚：这个项目到底是什么

LLM Wiki 是一个 **Tauri v2 桌面应用**。可以把它理解成"一个网站装进了一个 exe 里"：

```
┌───────────────────────────── LLM Wiki 应用窗口 ─────────────────────────────┐
│                                                                             │
│   前端（src/，你看到的界面）            后端（src-tauri/，Rust 写的）         │
│   React + TypeScript 页面      ──JS桥──► 读写文件、跑 LLM agent、开本地API    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **前端**：用网页技术（React/TypeScript）画界面、写业务逻辑。开发时它跑在一个浏览器内核里。
- **后端（Rust）**：负责操作系统才能干的事——读写磁盘、起进程、监听网络端口。
- 两者之间通过 Tauri 提供的 `invoke()` 桥接：前端喊一嗓子"帮我读文件"，Rust 那头执行后把结果传回来。

**关键认知：Jira 功能一行 Rust 都没写。** 它全部用前端 TypeScript 完成（HTTP 请求走 Tauri
提供的现成插件）。这对你理解本项目很重要——**不是每个功能都需要动 Rust**，很多功能是"纯前端逻辑 +
现成插件"就能拼出来的。

---

## 2. Jira 功能用到的技术栈

| 技术 | 版本 | 在这个功能里干什么 | 一句话解释它是什么 |
|---|---|---|---|
| **TypeScript** | ^5.7 | 所有 Jira 代码的书写语言 | 加了类型检查的 JavaScript，写错字段名编译期就报错 |
| **React** | ^19 | 界面（任务列表、详情、设置表单） | 用"组件+状态"描述界面的库，状态变了界面自动重画 |
| **Zustand** | ^5.0 | `jira-store.ts` 全局状态管理 | 一个极简的"全局变量仓库"，任何组件都能读/改，改了自动刷新界面 |
| **Vite** | ^8.0 | 开发服务器 + 打包器 | 负责"写完代码立刻看效果"（热更新）和"最后压成一个文件夹"（构建） |
| **@tauri-apps/plugin-http** | ^2.5 | 真正发出对 Jira 服务器的 HTTP 请求 | Tauri 的 Rust 网络插件。用它而不是浏览器 `fetch` 的原因：**绕过 CORS 限制**（企业内网 Jira 通常不会给浏览器发许可头） |
| **@tauri-apps/plugin-store** | ^2.4 | 把 Jira 配置（服务器地址、token）存到 `app-state.json` | Tauri 自带的"键值对存盘"插件 |
| **Tailwind CSS** | ^4.2 | 界面上的样式类（如 `flex gap-2 text-sm`） | 不写 CSS 文件，直接把样式写在标签上的工具类框架 |
| **shadcn/ui + lucide-react** | — | 按钮、输入框、图标 | 复制进仓库的现成 UI 组件库 + 图标库 |
| **react-i18next** | ^17 | 多语言（中/英/意/俄） | 界面上不写死中文，而是 `t("jira.refresh")` 查词典 |
| **Vitest** | ^4.1 | 单元测试（`jira-*.test.ts`） | 跑在 Node 里的测试框架，`npm test` 就是它 |
| **Jira REST API v2** | — | 功能对外的协议 | Atlassian 官方的 HTTP 接口，路径长这样：`https://你的jira/rest/api/2/search?jql=...` |
| **JQL** | — | 过滤要拉取哪些 issue | Jira Query Language，类似 SQL 的查询语句，默认 `issuetype in (缺陷,Bug) order by updated DESC` |
| **PAT（Personal Access Token）** | — | 鉴权 | 在 Jira 网站上生成的一串令牌，请求头带 `Authorization: Bearer <token>` |

---

## 3. 代码架构：九个文件各管一件事

这个项目最重要的设计哲学：**分层，每层只做一件事，上层可以依赖下层，下层绝不回头依赖上层。**
这样每层都能单独测试，也方便复用到别的功能。

```
            ┌────────────────────── 界 面 层 ──────────────────────┐
            │  jira-view.tsx        任务列表 / 详情 / 历史 主界面     │
            │  jira-task-list.tsx   列表组件                        │
            │  jira-task-detail.tsx 详情组件（含"导入 wiki"按钮）     │
            │  jira-section.tsx     设置页表单（地址/token/JQL…）     │
            └───────────────┬───────────────────▲──────────────────┘
                            │ 读状态             │ 用户操作
            ┌───────────────▼───────────────────┴──────────────────┐
            │        状 态 层  jira-store.ts  (Zustand)             │
            │   config / tasks / ledger / detailTask，改它=界面刷新    │
            └───┬───────────────┬────────────────┬─────────────────┘
                │               │                │
   ┌────────────▼───┐  ┌────────▼─────────┐  ┌───▼──────────────────┐
   │ 同 步 层        │  │ 通 信 层          │  │ 持 久 层              │
   │ jira-sync.ts   │  │ jira-api.ts      │  │ jira-persist.ts      │
   │ 定时轮询+对账     │  │ 唯一和 Jira 服务  │  │ 读写                 │
   │ +分析编排        │  │ 器说话的层        │  │ .llm-wiki/jira.json  │
   │ jira-analyze.ts│  │ (REST v2 客户端)  │  │ project-store.ts     │
   │  LLM 审查描述   │  └────────┬─────────┘  │  (app-state.json)    │
   └───────┬────────┘           │            └──────────────────────┘
           │                    ▼
   ┌───────▼────────┐   网络请求（Tauri plugin-http）──► Jira 服务器
   │ 桥 接 层        │
   │ jira-ingest.ts │──► 把 issue 写成 raw/sources/jira/KEY.md，
   └────────────────┘    塞进项目已有的"知识摄入管线"（复用，不重复造轮子）
```

各文件速览（路径都在 `src/` 下）：

| 文件 | 职责 | 新手该从它学到的点 |
|---|---|---|
| `lib/jira-config.ts` | 定义 `JiraConfig` 类型、默认值、`normalize/clamp` 清洗函数 | **纯函数层**：不依赖任何其它业务模块，谁都能安全引用 |
| `lib/jira-api.ts` | 唯一的 Jira 通信层：`jiraSearch` / `jiraGetIssue` / `jiraUpdateDescription` / `jiraTestConnection`；把 Jira 返回的 JSON 映射成内部 `JiraTask` | 错误分类（401/403 专门提示 token 问题）、一个响应解析器全项目共用 |
| `stores/jira-store.ts` | Zustand store：内存里的配置、任务列表、账本(ledger) | `useJiraStore((s) => s.tasks)` 的订阅式写法；`upsertLedger` 如何"保留用户导入意图不被轮询覆盖" |
| `lib/jira-sync.ts` | 每 60 秒心跳检查一次"是否到了配置的轮询间隔"，到了就去拉取、对账、触发 AI 分析、按保留期清理 | `setInterval` 轮询器模式（仿照项目里 `scheduled-import` 等已有写法）；`polling` 标志防重入 |
| `lib/jira-analyze.ts` | 构造 prompt 让 LLM 审查 issue 描述写得是否合格，解析返回的 JSON | prompt 工程 + "LLM 调用是尽力而为、失败不致命"的设计 |
| `lib/jira-persist.ts` | 账本（ledger）落盘到 `{项目}/.llm-wiki/jira.json` | 通过 `@/commands/fs` 写文件 = 走 Rust 桥接 |
| `jira/jira-ingest.ts` | 把单个 issue 转成 markdown 写入 `raw/sources/jira/`，再调用 `enqueueSourceIngest` | **桥接模式**：Jira 与摄入管线唯一的接触点，下游完全复用 |
| `jira/jira-view.tsx` | 主视图：列表/详情/历史三态切换、刷新按钮、错误横幅 | React hooks（`useState/useEffect/useCallback`）的典型用法 |
| `components/settings/sections/jira-section.tsx` | 设置表单 + "测试连接"按钮 | 受控组件：`value={draft.jiraServer}` + `onChange` 写回草稿 |

**接线点**（功能怎么挂进整个 App 的）：

- `App.tsx`：打开项目后调 `hydrateJiraAfterOpen()` → 读配置、塞进 store、`startJiraSync()` 启动轮询器。
- `components/layout/icon-sidebar.tsx`：侧边栏加 `jira` 图标入口（总开关关了就不显示）。
- `components/layout/content-area.tsx`：`activeView === "jira"` 时渲染 `<JiraView/>`。
- `lib/project-store.ts`：新增 `saveJiraConfig/loadJiraConfig`（存 `app-state.json`，保存 token 后强制刷盘）。
- `lib/reset-project-state.ts`：切项目时清空 Jira 内存状态。
- `i18n/{en,zh,it,ru}.json`：新增 `jira.*` 和 `settings.sections.jira.*` 词条。

> `enabled` 总开关贯穿全链：关掉后侧边栏隐藏、轮询器不跑、视图不渲染——这种"一个开关控制整个功能
> 的生死"叫 **feature flag（功能开关）**，是很常见的工程手法。

---

## 4. 数据是怎么流动的（完整链路）

一次完整的故事，从用户配置到 issue 进知识库：

```
① 用户打开 设置 → Jira，填服务器地址 + token，点"测试连接"
      jira-section.tsx ──► jira-api.ts::jiraTestConnection()
                                 │ GET /rest/api/2/myself   （经 Tauri Rust 发请求，无 CORS 问题）
                                 ▼
                          { ok: true, message: "Connected as 张三." }

② 点保存：settings-view 把草稿写回 → project-store.saveJiraConfig()
      → 规范化(normalizeJiraConfig：裁剪空格、clamp 间隔到 1~1440 分钟…)
      → 存进 app-state.json，并同步到 jira-store（内存）

③ 后台轮询器（App 启动时就挂上了 setInterval，每 60s tick 一次）
      jira-sync.ts::maybePoll()
        ├─ isJiraPollDue(config)? 没到间隔/开关没开 → 直接返回
        └─ jiraPoll():
            jiraSearch(config, jql)          ◄── Jira REST: GET /rest/api/2/search?jql=...&fields=...
              └─ mapJiraIssue(每个 issue)     ◄── Jira 的 JSON → 我们的 JiraTask（含解析 ADF 富文本描述）
            reconcileTasks(projectPath, tasks, analysisLevel)
              ├─ 新 issue / 内容变了的 issue → analyzeJiraTask() 让 LLM 审查描述，结果写进 ledger 缓存
              ├─ 已解决但从未导入的 issue    → 进入 7 天保留期（retainedUntil），过期自动清掉
              └─ store.setTasks/setLedger    ◄── 状态一变，React 界面自动刷新
            saveJiraConfig(lastPoll = now)   ◄── 记录上次轮询时间
            saveJiraLedger()                 ◄── 账本落盘 .llm-wiki/jira.json（重启不丢）

④ 用户在 JiraView 点某条 issue → 详情面板显示描述 + AI 分析结果

⑤ 用户点"导入到 wiki"（这是显式操作，轮询器永远不会自动导入）
      jira-ingest.ts::jiraTaskToWiki()
        ├─ 生成 markdown（# Jira KEY: 标题 + 原始描述 + AI 建议描述）
        ├─ writeFile → {项目}/raw/sources/jira/KEY.md
        ├─ enqueueSourceIngest(...) → 进入项目既有的摄入管线（摘要、建链、向量化、review…全是现成的）
        └─ markImported(KEY) → ledger 标记，之后这条 issue 永远不会被保留期清理掉
```

**划重点：**

- **轮询只"看"，导入才"动"**——AI 分析结果缓存进 ledger，但只有用户点按钮才会写知识库。
- **ledger（账本）** 记录每个 issue 的"首次见到/是否导入/分析缓存/解决时间/保留截止"，是跨重启的记忆。
- `analysisLevel: off/basic/deep` 控制 AI 分析深度：`off` 完全不调 LLM；`basic` 只看描述；`deep` 可带知识库上下文。

---

## 5. 开发流程：这个功能是怎么一步步做出来的

看 git 历史能反推出开发者的实际操作，这就是团队期望的流程：

```bash
git log --oneline
# ccba952 feat: 添加 Jira 集成功能，包含配置、状态切换和多语言支持   ← 第二次提交（补全）
# 4980d19 feat: add Jira integration with API client, ...          ← 第一次提交（骨架）
```

1. **拉 feature 分支**：当前分支叫 `dev_JIRA_LZY`（`dev_<任务号或模块>_<姓名缩写>`），不在 `main`
   上直接写。这是团队协作的基本规矩：一个功能一条分支。
2. **第一次提交（4980d19）**：一次性搭出"能跑的完整骨架"——API 客户端、配置、持久化、轮询、
   store、UI 三件套、设置面板、i18n 四语言、单元测试。共 29 个文件、约 2400 行。
   提交信息里逐条列了自己做了什么（这是规范：`feat:` 开头 + 正文列清单）。
3. **第二次提交（ccba952）**：小步补全——加 `enabled` 总开关、状态切换逻辑、中文文案，
   并同步更新了 `CLAUDE.md`（项目说明文档）。
4. **之后**：跑 `npm run typecheck`、`npm test` 确认没破坏别的功能，推送分支，走 PR/合并流程进 `main`。

> 值得学的模式：**新功能 = 新增自己的文件 + 最小化地改动"接线点"文件**
> （App.tsx / sidebar / content-area / project-store / i18n）。接线点改动都很小（各几行），
> 说明分层做得好，新功能像插头一样"插"进去，而不是把老代码拆开重接。

---

## 6. 开发环境搭建

### 6.1 需要装什么

| 依赖 | 版本要求 | 装它干嘛 | 怎么装 |
|---|---|---|---|
| **Node.js** | ≥ 20 | 跑前端工具链（vite/vitest/tsc） | nodejs.org 下载 LTS |
| **Rust** | ≥ 1.88 | 编译 Tauri 后端（即使 Jira 没写 Rust，整个 App 也需要它） | rustup.rs 一键装 |
| **VS Code**（推荐） | — | 编辑器 | 免费 |
| Windows 额外项 | — | Tauri 官方文档列出：Microsoft C++ Build Tools、WebView2（Win11 自带） | 见 Tauri 官方前置条件 |

> 只有从源码构建内置 MCP server 才需要额外装 `protoc`。**日常只改前端（比如改 Jira 逻辑）
> 不需要碰它。**

### 6.2 第一次搭起来

```bash
cd D:/LZY_project/llm_wiki
npm install        # 下载所有 JS 依赖（约几分钟）
npm run tauri dev  # 启动完整桌面应用（首次会编译 Rust，慢，5~10 分钟正常）
```

看到 LLM Wiki 窗口弹出来就成功了。之后改 `src/` 下任何 TS/TSX 文件，**保存即热更新**——
不用重启，几秒后窗口里自动生效。

---

## 7. 编译与构建：有哪些方式，都干了什么

本项目有 **4 条常用命令 + 1 条发布命令**，区别如下：

### 7.1 速查表

| 命令 | 产物 | 用在哪 | 需要 Rust 吗 |
|---|---|---|---|
| `npm run dev` | 无（内存里起个 dev server，端口 1420） | 只写纯前端逻辑、跑浏览器调试 | 不需要 |
| `npm run typecheck` | 无（只检查类型） | 提交前自查 | 不需要 |
| `npm run build` | `dist/` 文件夹（纯网页静态资源） | 只要 Web 版产物时 | 不需要 |
| `npm run tauri dev` | 弹出一个开发模式 App 窗口 | **日常开发主命令** | 需要（Rust 编译一次，之后增量） |
| `npm run tauri build` | 安装包：`src-tauri/target/release/bundle/` 下的 `.msi`/`.exe`/`.exe` 便携版 | 发布 | 需要（release 编译，很慢） |

### 7.2 底层发生了什么（看懂 tauri.conf.json）

`src-tauri/tauri.conf.json` 里的这段是"编译流水线"的说明书：

```jsonc
"build": {
  "beforeDevCommand":  "npm run dev",           // 开发窗口启动前：先拉起 Vite 热更新服务器
  "devUrl": "http://localhost:1420",            // App 窗口加载的就是这个地址
  "beforeBuildCommand": "npm run build:desktop", // 正式打包前：先准备好所有 JS 产物
  "frontendDist": "../dist"                     // 打包时把 dist/ 塞进 exe
}
```

所以：

- **`npm run tauri dev`** = 跑 `npm run dev`（Vite 热更新）+ `cargo` 增量编译 Rust + 打开窗口
  连 localhost:1420。前端改了立刻看到，Rust 改了自动重编译再重开。
- **`npm run tauri build`** = 跑 `npm run build:desktop`
  （它内部 = `npm --prefix mcp-server ci` + `npm run mcp:build` + `npm run build`，
  即"构建内置 MCP 服务 + typecheck + vite 打包出 dist"）+ `cargo build --release` +
  把 `dist/`、MCP 产物、图标等资源打成安装包。**顺序不能错：mcp-server/dist 必须在 tauri build
  之前构建好，否则打包会失败**——这是 CI 里的硬性步骤。

### 7.3 Jira 功能编译时要留意什么

Jira 的代码全在 `src/`（JS 侧），所以：

- 改 Jira 逻辑 → `npm run tauri dev` 秒级热更新，完全不触发 Rust 重编译；
- 只跑 Jira 单测 → `npx vitest run src/lib/jira-sync.test.ts`，**连 App 都不用开**（测试环境
  没有 Tauri，`getHttpFetch` 会自动回退到 Node 的 fetch，网络层又被 mock 掉了，见第 8 节）。

---

## 8. 测试是怎么做的

Jira 功能带了 5 个测试文件（Vitest 框架，与源码同目录、同名 `.test.ts` 后缀）：

```
src/lib/jira-config.test.ts   — 配置规范化：默认值、clamp 边界、旧配置兼容
src/lib/jira-api.test.ts      — REST 客户端：URL 拼接、Bearer 头、401 提示、JSON→JiraTask 映射、ADF 富文本拍平
src/lib/jira-sync.test.ts     — 轮询判定（isJiraPollDue）、账本合并（upsert）、TTL 清理
src/lib/jira-analyze.test.ts  — LLM 返回的 JSON 解析（含 ```json 围栏、脏数据容错）
src/jira/jira-ingest.test.ts  — 生成的 markdown 结构
```

### 8.1 核心思想：mock（假人测试）

单测不允许碰真网络、真磁盘、真 LLM——否则测试又慢又不稳定。做法是用 `vi.mock` 把外部依赖换成假的：

```ts
// jira-api.test.ts 里：把"发 HTTP 的层"换成一个可编程的假函数
const mockHttpFetch = vi.fn()
vi.mock("./tauri-fetch", async () => ({
  ...(await vi.importActual("./tauri-fetch")),
  getHttpFetch: () => Promise.resolve(mockHttpFetch),
}))

// 然后：告诉假函数"下次有人请求，就返回这个假 JSON"，再断言代码处理得对不对
mockHttpFetch.mockResolvedValue(Response.json({ issues: [rawIssue] }))
const tasks = await jiraSearch(cfg, {})
expect(tasks[0].assignee).toBe("李四")
```

jira-sync 测试同理：mock `./jira-analyze`（AI 结果固定）、mock `@/commands/fs`（写盘变空操作）。
**被测逻辑保持真身，依赖全部造假**——这是写单测最重要的心法。

### 8.2 怎么跑

```bash
npx vitest run src/lib/jira-sync.test.ts        # 跑单个文件
npx vitest run src/lib/jira-api.test.ts -t "401" # 按用例名过滤
npm run test:mocks                              # 全仓所有 mock 测试（Jira 的都在这里）
npm test                                        # = test:mocks + test:llm（后者要真实 LLM 环境，平时不用管）
```

另外有个 `src/i18n/i18n-parity.test.ts` 会强制检查 **en/zh/it/ru 四个语言文件键必须完全一致**——
所以第 5 节里"新增 `jira.*` 词条时四个文件一起改"不是好习惯，是**不这么改就过不了测试**。

---

## 9. 日常工作流（记住这个循环）

```
       ① 改代码（src/... 保存即热更新，App 窗口里实时看）
              │
       ② 有问题 → 窗口 DevTools（Ctrl+Shift+I）看 Console 报错 / 断点
              │
       ③ npx vitest run src/lib/jira-xxx.test.ts   # 跑相关单测
              │
       ④ npm run typecheck                          # 全量类型检查
              │
       ⑤ git add -A && git commit -m "feat: ..."    # 在 dev_JIRA_LZY 分支上，
         （Conventional Commits：feat:/fix:/test:/refactor: 前缀 + 正文列改动）
              │
       ⑥ git push → 走 PR / 合并到 main
              │
       ⑦ 发布前：npm run tauri build 产出安装包（内部自动先跑 build:desktop）
```

---

## 10. 新手读代码顺序建议

按"依赖最少 → 依赖最多"读，每一步都能独立看懂：

1. `src/lib/jira-config.ts` —— 纯类型 + 纯函数，零依赖，先认识 `JiraConfig` 长什么样。
2. `src/stores/jira-store.ts` —— 认识内存状态 `JiraTask`/`JiraLedgerEntry`，看一遍 Zustand 写法。
3. `src/lib/jira-api.ts` + 它的测试 —— 看"一个网络层应该长什么样"：拼 URL、鉴权、错误分类、JSON 映射。
   **对照测试读**是理解 mock 思想的最快途径。
4. `src/lib/jira-sync.ts` —— 把 1~3 串起来的轮询器；`reconcileTasks` 是整个功能的心脏。
5. `src/lib/jira-persist.ts`、`src/lib/project-store.ts`（`save/loadJiraConfig` 部分）—— 两种持久化：
   项目级账本（JSON 文件）vs 全局配置（app-state.json）。
6. `src/lib/jira-analyze.ts`、`src/jira/jira-ingest.ts` —— 与 LLM、与摄入管线的桥。
7. `src/jira/jira-view.tsx` → `jira-task-list.tsx` → `jira-task-detail.tsx` →
   `components/settings/sections/jira-section.tsx` —— 界面层，用 React hooks 的典型样本。
8. 最后看接线：`App.tsx` 的 `hydrateJiraAfterOpen`、`icon-sidebar.tsx`、`content-area.tsx` ——
   理解"新功能怎么挂进老 App"。

读的时候配合命令：`git show 4980d19 --stat` 看骨架提交改了哪些文件（本指南第 3 节即基于此整理）。

---

## 11. 附录：名词小词典

| 名词 | 大白话解释 |
|---|---|
| **REST API** | 服务器暴露的一组"网址+动作"：GET=查、PUT=改。Jira 把每个功能都做成了网页地址，程序去请求这些地址就等于"点按钮" |
| **JQL** | Jira 的查询语言，字符串形式过滤 issue，如 `project = ABC AND status = Open` |
| **PAT** | Personal Access Token，在你的 Jira 账号里生成的一串密码替代品，程序带它证明身份 |
| **CORS** | 浏览器的一种安全限制：A 网站的页面不能随便请求 B 服务器的接口。Tauri 插件用 Rust 发请求，不受此限制 |
| **热更新（HMR）** | Vite 的能力：代码改完保存，App 不用重启，界面几秒内自动替换成新代码的效果 |
| **状态管理 / store** | 把跨组件共享的数据放一个"全局仓库"，组件订阅它；仓库数据一变，相关组件自动重渲染 |
| **mock** | 测试时塞进去的"假依赖"：假网络、假磁盘、假 AI，让测试快且结果确定 |
| **feature flag（功能开关）** | 用一个配置字段整体启停某功能，而不是删代码 |
| **Conventional Commits** | 提交信息规范：`feat:` 新功能、`fix:` 修 bug、`test:` 加测试……便于工具自动生成更新日志 |
| **账本 ledger** | 本项目术语：每个 Jira issue 的"档案卡"——是否导入过、AI 分析缓存、什么时候解决的、保留到什么时候 |
| **TTL / retention** | Time-To-Live。已解决且从未导入的 issue 记录只保留 N 小时（默认 168 = 7 天），过期自动清理 |

---

*文档生成日期：2026-08-30；对应代码分支 `dev_JIRA_LZY`，commit `ccba952`。*
