# OpenClaw MVP 版本梳理 — Agent 运行时核心

## 执行步骤 0：创建项目目录

在你选择的目录下新建 `openclaw-mvp/` 文件夹，并将本计划文档复制进去作为 `PLAN.md`。

## Context

OpenClaw 的核心不是 IM 渠道对接，而是 **Agent 执行运作过程**：接收指令 → 构建上下文 → 调用 AI 模型 → 模型决定调用工具 → 执行工具 → 将结果反馈给模型 → 模型继续思考 → 最终返回回复。这个循环（Agent Loop）是整个系统的心脏。

MVP 目标：用最小代码复现这个 Agent Loop，让一个 AI agent 能够接收用户输入、调用工具、持续对话。

---

## Agent 执行核心循环

```
用户输入 (prompt)
    ↓
加载 Session（历史消息）
    ↓
构建 System Prompt（身份 + 工具描述 + 上下文）
    ↓
将 [system prompt, 历史消息, 用户消息] 发给 AI 模型
    ↓
模型返回响应 ──┬── 纯文本回复 → 输出给用户，结束
               │
               └── tool_call（工具调用）
                       ↓
                   查找工具 → 执行工具 → 获取结果
                       ↓
                   将工具结果追加到消息历史
                       ↓
                   再次调用模型（带工具结果）
                       ↓
                   循环，直到模型返回 end_turn
    ↓
保存 Session（更新历史消息）
    ↓
返回最终回复
```

---

## MVP 包含的 8 个核心模块

### 模块 1：Agent Loop（核心循环引擎）

**做什么**：实现上面的循环 — 接收 prompt → 调 AI → 处理 tool_call → 循环直到结束

**OpenClaw 中的对应**：
- `src/agents/pi-embedded-runner/run.ts` — 主运行循环（2392 行）
- `src/agents/pi-embedded-runner/run/attempt.ts` — 单次尝试执行
- `src/agents/pi-embedded-subscribe.ts` — 流式订阅与工具调用处理（2000+ 行）

**MVP 简化方案**：
- 不用 Pi SDK，直接调 OpenAI Chat Completions API（`fetch()`）
- 同步循环（非流式）：`while (true) { call model → if tool_call: execute → append result → continue; else break; }`
- 不需要：failover、auth profile 轮换、compaction safeguard、扩展系统
- ~200-300 行代码

**核心函数签名**：
```typescript
async function runAgent(params: {
  prompt: string;
  sessionFile: string;
  tools: Tool[];
  modelConfig: ModelConfig;
  systemPrompt: string;
}): Promise<AgentResult>
```

---

### 模块 2：Tool System（工具系统）

**做什么**：定义工具的 schema、注册工具、执行工具、返回结果

**OpenClaw 中的对应**：
- `src/agents/openclaw-tools.ts` — OpenClaw 自定义工具创建
- `src/agents/pi-tools.ts` — 工具总装（SDK 工具 + OpenClaw 工具 + 渠道工具）
- `src/agents/pi-tool-definition-adapter.ts` — 工具定义转换
- `src/agents/tool-policy-pipeline.ts` — 工具策略过滤
- `src/agents/tools/web-search.ts` 等 — 具体工具实现

**OpenClaw 工具架构层次**：
1. **定义层**：每个工具有 `name`, `description`, `parameters`(JSON Schema), `execute()`
2. **包装层**：abort signal、hook、workspace guard、参数规范化（5 层 wrapper）
3. **策略层**：profile/provider/agent/group/sandbox 多级过滤
4. **转换层**：`AgentTool` → `ToolDefinition`（适配不同模型提供商的 schema 要求）

**MVP 简化方案**：
- 工具接口极简：`{ name, description, parameters(JSON Schema), execute(params) → string }`
- 不需要包装层、策略层、转换层
- 直接把工具列表转成 OpenAI function calling 格式
- MVP 内置 3 个示例工具：
  - `read_file` — 读文件
  - `write_file` — 写文件
  - `run_command` — 执行 shell 命令
- ~150-200 行代码

**核心类型**：
```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;  // OpenAI function calling 格式
  execute: (params: Record<string, any>) => Promise<string>;
}
```

---

### 模块 3：Session Management（会话管理）

**做什么**：持久化对话历史，支持多轮对话、上下文恢复

**OpenClaw 中的对应**：
- `src/config/sessions/store.ts` — Session 持久存储（TTL 缓存、原子写、磁盘预算）
- `src/config/sessions/types.ts` — SessionEntry 类型（含 token 统计、模型记录）
- `src/agents/pi-embedded-runner/compact.ts` — 上下文压缩（防爆窗）
- `src/agents/pi-embedded-runner/history.ts` — 历史消息加载、截断、修复

**OpenClaw Session 架构**：
- SessionEntry 元数据（JSON store）：sessionId, sessionFile, model, totalTokens, updatedAt...
- Session 文件（JSONL transcript）：消息历史序列化
- 历史管理：加载 → 截断 → 修复 tool orphan → 模型适配验证 → 图片清理
- 上下文压缩：接近上下文窗口限制时自动摘要压缩旧消息

**MVP 简化方案**：
- 每个 session 一个 JSON 文件，存在 `~/.agent/sessions/` 下
- 内容就是 OpenAI messages 数组：`[{role, content, tool_calls?, tool_call_id?}]`
- 简单历史截断：超过 N 条消息时丢弃最早的
- 不需要：压缩、磁盘预算、TTL 缓存、transcript events
- ~100-150 行代码

**核心接口**：
```typescript
interface SessionManager {
  load(sessionId: string): Promise<Message[]>;
  save(sessionId: string, messages: Message[]): Promise<void>;
  list(): Promise<string[]>;
}
```

---

### 模块 4：System Prompt Builder（系统提示构建）

**做什么**：构建 agent 的系统提示，告诉 AI 它是谁、有哪些工具、当前上下文

**OpenClaw 中的对应**：
- `src/agents/system-prompt.ts` — 核心 prompt 构建器（多个 section）
- `src/agents/pi-embedded-runner/system-prompt.ts` — 嵌入式包装
- `src/agents/system-prompt-params.ts` — 参数准备

**OpenClaw System Prompt 结构**（10+ 段）：
1. 身份与授权（owner numbers, authorized senders）
2. 时间与时区
3. 工具清单（名称 + 摘要，按顺序排列）
4. 消息路由（跨渠道发送）
5. 记忆系统（memory_search/get 使用指南）
6. Skills 系统（技能发现与读取）
7. 沙箱信息（workspace 路径、限制）
8. 语音/TTS
9. 文档链接
10. 安全约束

**MVP 简化方案**：
- 仅保留 3 段：身份 + 工具描述 + 当前上下文（工作目录、时间）
- 工具描述自动从 Tool 列表生成
- 支持用户自定义 instructions（类似 CLAUDE.md）
- ~50-80 行代码

---

### 模块 5：Model API Client（模型 API 客户端）

**做什么**：调用 AI 模型 API，发送消息、接收回复（含 tool_calls）

**OpenClaw 中的对应**：
- `src/agents/pi-model-discovery.ts` — 模型发现（Pi SDK ModelRegistry）
- `src/agents/models-config.ts` — 模型配置管理
- `src/agents/models-config.providers.ts` — 30+ 提供商配置
- `src/agents/auth-profiles.ts` — 认证凭据管理（cooldown/failure tracking）
- `src/agents/pi-embedded-runner/model.ts` — 运行时模型解析
- `src/agents/pi-embedded-runner/run/attempt.ts` — 流式 API 调用

**OpenClaw 模型调用链**：
1. 从 config 解析 provider + model
2. 从 auth-profiles 获取 API key
3. 通过 Pi SDK 的 ModelRegistry 发现模型能力
4. 构建 stream function（按提供商类型：Anthropic/OpenAI/Google/Ollama）
5. 应用 extra params（cache control、reasoning、verbose）
6. 流式调用 → 逐 chunk 处理（delta text、tool calls、thinking blocks）

**MVP 简化方案**：
- 仅支持 OpenAI Chat Completions API（兼容 OpenAI、Ollama、各种代理）
- 直接 `fetch()` 调用，非流式（`stream: false`）
- 配置：`{ apiKey, baseUrl, model }`
- 不需要：模型发现、auth profile 轮换、流式处理、provider 抽象
- ~80-120 行代码

**核心函数**：
```typescript
async function callModel(params: {
  messages: Message[];
  tools: ToolDefinition[];
  config: ModelConfig;
}): Promise<ModelResponse>
// ModelResponse = { message: AssistantMessage, usage: TokenUsage }
```

---

### 模块 6：CLI Interface（命令行界面）

**做什么**：用户通过终端与 agent 交互（REPL 模式）

**OpenClaw 中的对应**：
- `src/cli/program/build-program.ts` — Commander CLI 构建
- `src/commands/agent.ts` — agent 命令
- `src/tui/` — Terminal UI
- `src/terminal/palette.ts` — 颜色主题

**MVP 简化方案**：
- 简单 REPL：`readline` 循环，用户输入 → agent 处理 → 打印回复
- 支持 `--session <id>` 恢复历史会话
- 支持 `--model <model>` 指定模型
- 不需要 Commander、进度条、颜色主题
- ~50-80 行代码

---

### 模块 7：Context Compaction（上下文压缩）

**做什么**：当对话历史接近模型上下文窗口限制时，自动压缩旧消息，保持 agent 能持续运转

**OpenClaw 中的对应**：
- `src/agents/pi-embedded-runner/compact.ts` — 主压缩入口
- `src/agents/pi-extensions/compaction-safeguard.ts` — 质量安全保障扩展
- `src/agents/pi-extensions/context-pruning/` — 内存级上下文裁剪
- `src/agents/pi-embedded-runner/history.ts` — 历史截断与修复
- `src/agents/compaction.ts` — 分块、token 估算、摘要生成

**OpenClaw 上下文压缩的完整机制**：

**触发时机**：
- 模型返回上下文溢出错误（"context length exceeded"、"request_too_large" 等）
- 手动触发（`/compact` 命令）
- 最多重试 3 次（`MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3`）

**两种模式**：
1. **Safeguard 模式**（默认推荐）— 结构化摘要 + 质量检查
2. **Default 模式** — SDK 内置简单压缩

**Safeguard 模式完整流程**：
1. 将消息分为「可摘要部分」和「保留的近期轮次」
   - `recentTurnsPreserve`：保留最近 N 轮完整对话（默认 3 轮，最多 12 轮）
   - 近期 assistant 消息关联的 tool_result 也一并保留
2. 自适应分块：
   - 基础块比率 `BASE_CHUNK_RATIO = 0.4`，按平均消息大小向下调整
   - 安全边际 `SAFETY_MARGIN = 1.2`（补偿 token 估算误差 20%）
3. 多阶段摘要：
   - 将可摘要消息按 token 上限分块
   - 对每个块调用 AI 生成摘要
   - 预留 `SUMMARIZATION_OVERHEAD_TOKENS = 4096` 给摘要本身
4. 质量检查：
   - 验证摘要包含必要章节：`## Decisions`, `## Open TODOs`, `## Constraints/Rules`, `## Pending user asks`, `## Exact identifiers`
   - 检查关键标识符（URL、UUID、文件路径）是否被保留
   - 检查最新用户请求是否反映在摘要中
   - 质量不达标时重新生成（最多重试 3 次）
5. 上下文注入：
   - 追加工具失败摘要（最多 8 条，每条 240 字符）
   - 追加文件操作记录（读取 vs 修改的文件）
   - 注入 workspace 关键规则（AGENTS.md 的 "Session Startup" + "Red Lines"）

**保留策略**：
- System Prompt：永不修改
- 近期轮次：最后 N 轮完整保留
- 精确标识符：URL、UUID、hash、hostname、port、文件路径
- 工具失败记录：摘要保留
- 文件操作记录：读/写文件列表

**工具对配修复**：
- 截断后可能产生孤儿 tool_result（没有对应的 tool_call）
- `sanitizeToolUseResultPairing()` 自动清理孤儿对
- `repairToolUseResultPairing()` 修复分割后的配对

**Context Pruning（上下文裁剪，区别于压缩）**：
- 仅影响当前请求的内存，不重写磁盘历史
- 按 cache-TTL 模式选择性移除旧的 assistant 轮次
- 用 `[image removed during context pruning]` 替换被移除的图片
- 与压缩正交：裁剪是请求级优化，压缩是持久化变更

**MVP 简化方案**：
- 实现基础版压缩：当消息数超过阈值时，用 AI 摘要旧消息
- 简化流程：`if (tokenCount > limit * 0.8) { summarize older half → replace with summary }`
- 保留近期 3 轮完整对话
- 不需要：质量检查、标识符策略、多阶段分块、Context Pruning
- ~150-200 行代码

**核心函数**：
```typescript
async function compactHistory(params: {
  messages: Message[];
  maxTokens: number;
  modelConfig: ModelConfig;
  recentTurnsKeep?: number;  // 默认 3
}): Promise<Message[]>
```

---

### 模块 8：Memory System（长期记忆系统）

**做什么**：跨会话的持久化语义记忆 — agent 能记住过去对话中的事实、决定、偏好

**OpenClaw 中的对应**：
- `src/memory/manager.ts` — 核心记忆管理器（1000+ 行）
- `src/memory/manager-search.ts` — 搜索策略
- `src/memory/hybrid.ts` — 混合搜索（向量 + 关键词）
- `src/memory/mmr.ts` — 最大边际相关性重排序
- `src/memory/temporal-decay.ts` — 时间衰减
- `src/memory/memory-schema.ts` — SQLite schema
- `src/agents/tools/memory-tool.ts` — agent 记忆工具
- `src/context-engine/` — 上下文引擎抽象
- `extensions/memory-lancedb/` — LanceDB 后端（可选）

**OpenClaw 记忆系统完整架构**：

**存储层**：
- Markdown 文件为单一事实来源：
  - `MEMORY.md`：策划的长期记忆（事实、决定、偏好）— 仅私聊加载
  - `memory/YYYY-MM-DD.md`：日志式记忆（按天追加）
- SQLite 索引数据库（`~/.openclaw/memory/{agentId}.sqlite`）：
  - `files` 表：文件元数据（路径、hash、mtime、大小）
  - `chunks` 表：文本块 + 向量嵌入
  - `embedding_cache` 表：嵌入缓存
  - FTS5 虚拟表：全文搜索

**分块策略**：
- 默认块大小：400 tokens
- 重叠：80 tokens（保持跨块上下文连续性）

**检索层 — 混合搜索**：
1. **向量搜索**（语义匹配）：
   - 查询文本 → 嵌入向量（支持 OpenAI/Gemini/Voyage/Mistral/Ollama/本地）
   - 余弦相似度搜索
   - 返回 top `maxResults × candidateMultiplier`（默认 ~200 候选）
2. **关键词搜索**（BM25 FTS5）：
   - SQLite 全文搜索，精确匹配 token（ID、代码符号、错误字符串）
3. **结果合并**：
   - BM25 rank → 0..1 分数：`textScore = 1 / (1 + bm25Rank)`
   - 加权融合：`finalScore = vectorWeight × vectorScore + textWeight × textScore`
   - 默认权重：向量 0.7，关键词 0.3
4. **可选后处理**：
   - **MMR（最大边际相关性）**：平衡相关性与多样性（Jaccard 文本相似度）
   - **时间衰减**：指数衰减，最新记忆权重更高（可配置半衰期，默认 30 天）

**检索默认参数**：
- 最大结果数：6
- 最低分数阈值：0.35
- 混合搜索：开启
- 候选倍数：4
- MMR：默认关闭（lambda: 0.7）
- 时间衰减：默认关闭

**Agent 工具接口**：
- `memory_search(query, maxResults?, minScore?)` — 语义搜索记忆片段
  - 返回：path, startLine, endLine, score, snippet（~700 字符），source
  - 支持引用：`Source: {path}#{line}`
- `memory_get(path, from?, lines?)` — 定向读取特定记忆文件的指定行

**System Prompt 中的记忆指令**：
```
## Memory Recall
Before answering anything about prior work, decisions, dates, people,
preferences, or todos: run memory_search on MEMORY.md + memory/*.md;
then use memory_get to pull only the needed lines.
If low confidence after search, say you checked.
```

**记忆 vs 会话历史的区别**：
| 维度 | 记忆（Memory） | 会话历史（Session） |
|------|-------------|-----------------|
| 范围 | 跨会话持久化 | 当前会话 |
| 存储 | Markdown 文件 + SQLite 索引 | JSON 消息数组 |
| 检索 | 语义搜索 + 关键词 | 自动包含在上下文窗口 |
| 写入 | Agent 显式写入文件 | 运行时自动记录 |
| 压缩 | 不压缩（文件即真相） | 超限时摘要压缩 |

**Context Engine 模式**（可插拔生命周期）：
```typescript
interface ContextEngine {
  bootstrap?(): Promise<BootstrapResult>     // 初始化
  ingest(): Promise<IngestResult>            // 摄入单条消息
  afterTurn?(): Promise<void>                // 轮次后处理
  assemble(): Promise<AssembleResult>        // 在 token 预算内组装上下文
  compact(): Promise<CompactResult>          // 压缩
  dispose?(): Promise<void>                  // 清理
}
```
- 引擎可插拔注册，默认使用 "legacy" 引擎
- `assemble()` 在 token 预算内构建完整上下文（system prompt + history + memory）
- 插件可通过 `api.registerContextEngine()` 注册自定义引擎

**MVP 简化方案**：
- 用 Markdown 文件作为记忆存储（与 OpenClaw 一致）
- 简化检索：仅关键词搜索（不需要向量嵌入和 SQLite）
  - 用 `grep` 或简单字符串匹配搜索 `MEMORY.md` + `memory/*.md`
- 提供 2 个工具：`memory_search(query)` 和 `memory_save(content)`
- 不需要：向量嵌入、SQLite、混合搜索、MMR、时间衰减、Context Engine
- ~100-150 行代码

**核心接口**：
```typescript
interface MemoryManager {
  search(query: string, maxResults?: number): Promise<MemoryResult[]>;
  save(content: string, filename?: string): Promise<void>;
  get(path: string, fromLine?: number, lines?: number): Promise<string>;
}
```

---

## MVP 不包含的部分

| 组件 | 为什么不需要 |
|------|------------|
| IM 渠道（Telegram/Discord/Slack 等） | 外壳，不影响 agent 核心运作 |
| Gateway WebSocket 服务 | 用 CLI REPL 替代，直接交互 |
| 插件系统 | MVP 工具硬编码，后续再抽象 |
| 流式输出 | 非流式（`stream:false`）已足够理解核心流程 |
| 沙箱/Docker 隔离 | 安全特性，非核心 |
| 多 AI 提供商 | OpenAI 兼容 API 足够 |
| Auth profile 轮换 | 单 API key 足够 |
| 子 Agent 系统 | 高级特性 |
| ACP 协议 | 远程 agent 管理，非核心 |
| Skills 系统 | 增强功能 |
| 浏览器自动化 | 增强功能 |
| 媒体管道 | 增强功能 |
| 原生应用 | CLI 足够 |
| Hook 系统 | 增强功能 |
| 工具策略/权限 | 简化掉 |

---

## 核心数据对比

| 指标 | 完整 OpenClaw | MVP |
|------|-------------|-----|
| 源文件数 | ~800+ | ~15-20 |
| 代码行数 | ~150k+ | ~1200-1800 |
| 工具包装层 | 5 层 | 0 层（直接执行） |
| 工具策略层 | 6 级过滤 | 无（全部可用） |
| System Prompt 段落 | 10+ | 3 |
| 模型提供商 | 30+ | 1（OpenAI 兼容） |
| 会话管理功能 | 压缩/预算/缓存/修复 | 加载/保存/截断/基础压缩 |
| 记忆系统 | 向量+BM25混合搜索/SQLite/MMR | 关键词搜索/Markdown文件 |
| npm 依赖 | 100+ | ~3-5 |

---

## 项目文件结构（MVP）

```
src/
├── index.ts              # CLI REPL 入口（模块 6）
├── agent-loop.ts         # 核心循环引擎（模块 1）
├── tools.ts              # 工具系统：接口 + 注册 + 执行（模块 2）
├── tools/
│   ├── read-file.ts      # 内置工具：读文件
│   ├── write-file.ts     # 内置工具：写文件
│   ├── run-command.ts    # 内置工具：执行命令
│   ├── memory-search.ts  # 内置工具：搜索记忆
│   └── memory-save.ts    # 内置工具：保存记忆
├── session.ts            # 会话管理（模块 3）
├── compaction.ts         # 上下文压缩（模块 7）
├── memory.ts             # 长期记忆系统（模块 8）
├── system-prompt.ts      # System Prompt 构建（模块 4）
├── model-client.ts       # AI 模型 API 客户端（模块 5）
└── types.ts              # 共享类型定义
```

---

## 实现阶段

### Phase 1: 项目骨架 + 类型定义 + 模型客户端

**项目初始化**：
- `npm init -y` 创建项目
- 安装依赖：`typescript`、`tsx`（运行 TS 用）、`@types/node`
- 创建 `tsconfig.json`（target: ES2022, module: ES2022, strict: true）

**类型定义** → `src/types.ts`：
- `Message` 联合类型：SystemMessage | UserMessage | AssistantMessage | ToolResultMessage
- `ToolCall`：模型返回的工具调用请求（id + function name + arguments JSON 字符串）
- `Tool`：工具接口（name + description + parameters JSON Schema + execute 函数）
- `ToolDefinition`：发给模型的工具格式（OpenAI function calling 格式）
- `ModelConfig`：模型连接配置（apiKey + baseUrl + model）
- `AgentResult`：执行结果（reply + messages + usage）
- `TokenUsage`：token 用量统计

**模型客户端** → `src/model-client.ts`：
- `callModel({ messages, tools?, config })` — 调用 OpenAI 兼容 API（非流式 stream:false）
- `toToolDefinitions(tools)` — 把 Tool[] 转成模型要求的 ToolDefinition[] 格式
- 请求体字段：model, messages, stream:false, tools(可选), tool_choice:"auto"(可选)
- 错误处理：HTTP 状态码检查、空响应检查

**验证**：
- 写临时测试脚本 `src/test-model.ts`
- 发一条"你好，请用一句话介绍你自己"给模型
- 确认收到回复并打印 token 用量

---

### Phase 2: 工具系统

**工具注册表** → `src/tools.ts`：
- `registerTool(tool)` — 注册工具到 Map
- `getAllTools()` — 获取所有已注册的工具
- `executeTool(name, params)` — 按名字查找并执行，失败时返回错误信息而非抛异常

**3 个内置工具**（每个工具一个文件，统一结构）：

`src/tools/read-file.ts` — 读文件：
- 参数：`{ path: string }`
- 执行：`fs.readFile(path, 'utf-8')`

`src/tools/write-file.ts` — 写文件：
- 参数：`{ path: string, content: string }`
- 执行：自动创建父目录 + `fs.writeFile(path, content)`

`src/tools/run-command.ts` — 执行 shell 命令：
- 参数：`{ command: string }`
- 执行：`child_process.exec(command)`，30 秒超时，返回 stdout + stderr

**验证**：
- 更新测试脚本，注册 3 个工具，让 AI "读取 package.json"
- 确认 AI 返回 tool_call（而非纯文本），手动执行工具并打印结果

---

### Phase 3: Agent Loop + Web UI + 日志系统

**核心循环** → `src/agent-loop.ts`：
- `runAgentLoop({ messages, config, onLog })` — Agent Loop 主函数
- 循环逻辑：调模型 → 如果 tool_call → 执行工具 → 追加结果 → 再调模型 → 直到纯文本回复
- 最大循环 10 次，防止死循环
- `onLog` 回调：每产生一条日志立刻通知外部（用于 SSE 实时推送）
- 日志类型（`LogEntry`）：
  - `thinking` — "正在调用模型..."
  - `api_request` — 发给 AI 的完整请求体（model + messages + tools + stream + tool_choice）
  - `api_response` — AI 返回的原始响应（message + usage）
  - `tool_call` — AI 决定调用的工具名 + 参数
  - `tool_result` — 工具执行结果（超过 500 字符截断）
  - `reply` — 最终回复
  - `error` — 错误信息

**HTTP 服务器** → `src/server.ts`：
- 用 Node.js 内置 `http` 模块（零依赖）
- `GET /` → 返回前端 HTML 页面
- `POST /chat` → SSE 流式响应（`Content-Type: text/event-stream`）
  - 每条日志用 `res.write('data: ${JSON.stringify(log)}\n\n')` 实时推送
  - 结束时发 `data: [DONE]`
- 内存中保持对话历史（conversationHistory 数组）
- 注册 3 个内置工具
- 简单 system prompt：身份 + 当前工作目录

**前端页面** → `src/public/index.html`（单文件，引入 marked.js CDN）：

布局：
- 顶部 header：标题 + 说明
- 主区域左右分栏：左侧对话区 + 可拖拽分割条 + 右侧日志面板

左侧对话区：
- 消息气泡（用户蓝色靠右、AI 深灰色靠左）
- AI 回复支持 Markdown 渲染（marked.js）
- 底部输入框 + 发送按钮，支持 Enter 发送（中文输入法兼容 isComposing）
- 发送后显示"AI 正在思考..."加载动画

右侧日志面板：
- 每种日志类型用不同颜色区分：
  - 黄色 `thinking` [思考]
  - 紫色 `api_request` [发送给AI] — detail 展示完整请求体 JSON
  - 橙色 `api_response` [AI原始返回] — detail 展示完整响应 JSON
  - 蓝色 `tool_call` [调用工具] — detail 展示参数
  - 绿色 `tool_result` [工具结果] — detail 展示返回值
  - 蓝白色 `reply` [最终回复] — Markdown 渲染
  - 红色 `error` [错误]
- detail 区域：max-height 200px，可滚动
- 每次对话间加虚线分隔

可拖拽分割条：
- 5px 宽，hover 变红色高亮
- mousedown → mousemove 动态调整右侧面板宽度
- 左侧最小 300px，右侧最小 200px
- 拖拽时禁止文本选中

SSE 流式接收：
- 用 `fetch()` + `ReadableStream` 逐行读取 SSE 事件
- 每收到一条日志立刻追加到日志面板（实时效果）
- 收到 `reply` 类型时更新左侧对话气泡
- 收到 `[DONE]` 时恢复输入框

**验证**：
1. 启动：`GLM_API_KEY=你的key npx tsx src/server.ts`，打开 http://localhost:3000
2. 输入"你好" → 纯文本回复，日志显示一轮调用
3. 输入"帮我看看当前目录有什么文件" → AI 调 run_command，日志实时展示每一步
4. 输入"创建 hello.txt 写入 Hello World，然后读取它" → AI 连续调两个工具
5. 拖动分割条 → 左右面板宽度可调整
6. 日志面板的 [发送给AI] 展示完整请求体（含 model、messages、tools、stream、tool_choice）
7. 日志面板的 [AI原始返回] 展示完整响应（含 message、usage）

### Phase 4: Session 管理

**后端** → `src/session.ts`：
- 每个 session 一个 JSON 文件，存在 `~/.agent/sessions/` 下
- `loadSession(id)` / `saveSession(id, messages)` / `listSessions()` / `newSessionId()`
- 简单历史截断：超过 50 条消息时保留 system prompt + 最近的消息
- 每次对话完成后自动保存 session

**Web UI**：
- 顶部 header 右侧加 session 选择器（下拉框）+ "新建会话"按钮
- 切换 session 时自动加载历史消息到左侧对话区
- 每次 chat 完成后刷新 session 列表

**API 接口**：
- `GET /sessions` → 返回 session 列表 + currentSessionId
- `POST /sessions/new` → 创建新 session，返回新 sessionId
- `POST /sessions/switch` → 切换到指定 session，返回历史消息

**日志透明度**：
- 切换/新建 session 时日志面板显示提示
- 每次对话完成后日志显示"session 已保存到 xxx"

**验证**：
1. 对话几轮 → 刷新页面 → 选择器中能看到 session → 切换回来历史消息还在
2. 新建会话 → 对话区清空，旧会话可切回

---

### Phase 5: System Prompt 增强

**后端** → `src/system-prompt.ts`：
- `buildSystemPrompt()` 构建完整 system prompt，返回 message + loadedInstructions 标记
- 3 段结构：身份（你是谁 + 记忆系统使用指令）+ 工具描述（自动从 Tool 列表生成）+ 上下文（工作目录 + 自定义指令）
- 上下文中**不包含时间**（AI 需要时间应通过工具获取）
- 支持用户自定义 instructions 文件（`~/.agent/instructions.md`），存在则追加到上下文段末尾
- 服务器启动时构建一次，之后固定不变（中途修改 instructions.md 需重启生效）

**Web UI**：
- 顶部加"设置"按钮，点击弹出模态框
- 设置面板中显示当前完整 system prompt（只读预览）
- 底部提示自定义指令文件路径

**API 接口**：
- `GET /system-prompt` → 返回 system prompt 内容 + instructionsPath + loadedInstructions

**日志透明度**：
- [发送给AI] 日志的 messages 数组第一条 system 消息中包含完整 3 段内容（含自定义指令）
- 终端启动时打印是否加载了自定义指令

**验证**：
1. 修改 instructions.md → 重启 → 点"设置"看到新内容
2. [发送给AI] 日志中 system 消息包含自定义指令内容

---

### Phase 6: 上下文压缩

**后端** → `src/compaction.ts`：
- `estimateTokens(messages)` — token 估算（字符数 / 2）
- `needsCompaction(messages)` — 判断是否超过 80% 阈值（MAX_TOKENS = 32000）
- `compactHistory({ messages, config, onLog })` — 执行压缩：
  1. 分离 system prompt（永不压缩）
  2. 保留最近 3 轮完整对话
  3. 把更早的消息拼成文本，发给 AI 生成摘要（独立调用 callModel，不带 tools）
  4. 用摘要（伪装成 user+assistant 消息对）替换旧消息
- 集成到 Agent Loop：每次循环开始前检查，超限则自动压缩并同步回原 messages 数组

**Web UI**：
- 顶部 header 显示 token 进度条（数字 + 彩色条）
  - 蓝色 = 正常（<50%）
  - 黄色 = 警告（50%-80%）
  - 红色 = 危险（>80%，即将触发压缩）
- 每次对话完成后通过 SSE 推送 token_usage 事件更新进度条

**日志透明度**：
- 压缩触发时日志显示紫色 [压缩] 类型：
  - "token 估算：25600 / 32000，触发压缩"
  - "保留最近 3 轮（N 条消息），压缩前 M 条为摘要"
  - "压缩完成：25600 tokens → 8000 tokens"

**验证**：
1. 持续对话 → 观察 token 进度条增长和颜色变化
2. 触发压缩后 → 日志面板显示压缩过程
3. 压缩后 AI 仍能通过摘要知道之前聊了什么

---

### Phase 7: 记忆系统

**后端** → `src/memory.ts`：
- `searchMemory(query, maxResults)` — 关键词搜索（所有关键词必须全部匹配）
  - 遍历 `~/.agent/memory/` 下所有 .md 文件
  - 逐行匹配，返回 `[文件名:行号] 匹配内容`
- `saveMemory(content)` — 追加到 `~/.agent/memory/MEMORY.md`（带时间戳）
- `getMemoryInfo()` — 返回文件数量、总行数、MEMORY.md 内容（用于设置面板）

**2 个新工具**：
- `src/tools/memory-search.ts` — `memory_search({ query })` → 调用 searchMemory
- `src/tools/memory-save.ts` — `memory_save({ content })` → 调用 saveMemory

**System Prompt 中的记忆指令**（写在身份段）：
- 当用户提到偏好、重要决定、关键事实时，主动使用 memory_save 保存
- 当用户问起之前聊过的内容、偏好、决定时，先用 memory_search 搜索
- 不需要用户明确要求"记住"，AI 应该主动判断什么值得记忆

**Web UI**：
- 设置面板中加记忆管理区域：展示 MEMORY.md 内容（只读）+ 文件统计

**API 接口**：
- `GET /memory` → 返回记忆信息（fileCount, totalLines, content）

**日志透明度**：
- memory_search / memory_save 工具调用时，通过已有的 [调用工具] 和 [工具结果] 日志展示搜索词、匹配结果、保存内容

**验证**：
1. 让 AI "记住我喜欢用 TypeScript" → 日志显示 memory_save 调用 → 检查 MEMORY.md 文件
2. 新 session 中问"我喜欢什么语言" → 日志显示 memory_search 调用 → AI 回答 "TypeScript"
3. 点"设置" → 记忆区域能看到保存的记忆内容

---

### Phase 8: 测试 + 打磨

**UI 打磨**：
- 日志面板 detail 区域默认折叠，点 `[展开]`/`[收起]` 切换（api_request/api_response 的 JSON 不再刷屏）
- 日志面板标题旁加"清空"按钮
- 对话区消息 hover 时显示"复制"按钮

**文档**：
- README.md：项目介绍、启动方式、架构图、文件结构、8 个模块说明、数据存储位置、技术栈

---

## 验证方式

1. **基础对话**：启动 REPL → 输入问题 → 收到 AI 回复
2. **工具调用**：让 AI "读取当前目录的文件列表" → AI 调用 `run_command(ls)` → 返回文件列表
3. **多轮工具链**：让 AI "创建一个 hello.py 文件并运行它" → AI 调用 `write_file` → 调用 `run_command(python hello.py)` → 返回结果
4. **会话恢复**：退出 REPL → 用同一个 session id 重新启动 → AI 记得之前的对话
5. **连续工具调用**：让 AI "读取 package.json，然后告诉我有哪些依赖" → AI 调用 `read_file` → 分析内容 → 回复
6. **上下文压缩**：持续对话 50+ 轮 → 触发自动压缩 → agent 仍能正常回复且记得关键信息
7. **记忆存取**：让 AI "记住我喜欢用 TypeScript" → AI 调用 `memory_save` → 新 session 中问 "我喜欢什么语言" → AI 调用 `memory_search` → 回答 "TypeScript"

---

## 关键参考文件（从 OpenClaw 学习）

| 要学什么 | 看哪个文件 |
|---------|-----------|
| Agent Loop 完整流程 | `src/agents/pi-embedded-runner/run.ts` |
| 单次执行尝试 | `src/agents/pi-embedded-runner/run/attempt.ts` |
| 流式订阅 + 工具调用处理 | `src/agents/pi-embedded-subscribe.ts` |
| 工具定义和创建 | `src/agents/openclaw-tools.ts`, `src/agents/pi-tools.ts` |
| 工具定义转换 | `src/agents/pi-tool-definition-adapter.ts` |
| System Prompt 构建 | `src/agents/system-prompt.ts` |
| 会话存储 | `src/config/sessions/store.ts` |
| 上下文压缩（入口） | `src/agents/pi-embedded-runner/compact.ts` |
| 上下文压缩（质量保障） | `src/agents/pi-extensions/compaction-safeguard.ts` |
| 上下文压缩（分块/token 估算） | `src/agents/compaction.ts` |
| 历史截断与修复 | `src/agents/pi-embedded-runner/history.ts` |
| 上下文裁剪 | `src/agents/pi-extensions/context-pruning/` |
| 记忆管理器 | `src/memory/manager.ts` |
| 混合搜索 | `src/memory/hybrid.ts`, `src/memory/mmr.ts`, `src/memory/temporal-decay.ts` |
| 记忆工具 | `src/agents/tools/memory-tool.ts` |
| 记忆 schema | `src/memory/memory-schema.ts` |
| 记忆配置 | `src/agents/memory-search.ts` |
| Context Engine | `src/context-engine/types.ts`, `src/context-engine/registry.ts` |
| 模型配置 | `src/agents/models-config.ts` |
| 工具策略 | `src/agents/tool-policy-pipeline.ts` |
