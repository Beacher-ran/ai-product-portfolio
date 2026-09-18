# OpenClaw MVP

一个最小可运行的 Agent Loop 运行时核心，参考 OpenClaw 的 8 模块设计：

`感知输入 → LLM 推理 → 工具调用 → 工具执行 → 结果回传 → 上下文整合 → 输出回复 → 循环判断`

## 已实现能力

- **模型客户端**：OpenAI 兼容接口，已对接 GLM-5.3（`https://open.bigmodel.cn/api/paas/v4`）
- **Agent Loop**：自动判断是否需要继续调用工具，支持多轮工具链
- **5 个内置工具**：
  - `read_file` / `write_file`：读写本地文件
  - `run_command`：执行本地命令（工作目录限制在项目根目录）
  - `memory_save` / `memory_search`：跨会话长期记忆
- **Session 管理**：会话自动持久化到 `~/.agent/sessions/`
- **记忆系统**：追加写入 `~/.agent/memory/MEMORY.md`，关键词搜索，任意命中即返回
- **上下文压缩**：token 超过阈值时自动摘要历史消息
- **System Prompt**：支持自定义指令文件 `~/.agent/instructions.md`
- **Web UI**：
  - 双栏布局（左对话 / 右日志）
  - 可拖拽分割条
  - SSE 流式输出
  - 日志按类型分色
  - token 进度条
  - 会话新建 / 切换
  - 设置面板（System Prompt + 记忆浏览）
  - 全 CORS 开放，支持本地文件或 iframe 预览
- **CLI REPL**：终端交互模式，可直接对话

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 GLM API Key

把 key 写入环境变量：

```bash
# Windows PowerShell
$env:GLM_API_KEY="你的key"

# Git Bash / WSL
export GLM_API_KEY="你的key"
```

或放在项目根目录下的 `api-key.txt`，启动脚本自行读取。

### 3. 启动 Web 服务

```bash
npm run server
```

打开浏览器访问：http://localhost:3000

### 4. 启动 CLI REPL

```bash
npm run cli
```

可用参数：

```bash
npx tsx src/index.ts --session s-xxx --model glm-5.3
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GLM_API_KEY` | - | 必填，GLM API Key |
| `GLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | 模型接口地址 |
| `GLM_MODEL` | `glm-5.3` | 模型名 |
| `GLM_EFFORT` | `low` | reasoning effort（low/medium/high） |
| `GLM_MAX_TOKENS` | `8192` | 最大输出 token |
| `PORT` | `3000` | Web 服务端口 |

## 项目结构

```
openclaw-mvp/
├── src/
│   ├── types.ts              # 核心类型
│   ├── model-client.ts       # LLM 客户端（OpenAI 兼容）
│   ├── tools.ts              # 工具注册表
│   ├── tools/                # 内置工具实现
│   │   ├── read-file.ts
│   │   ├── write-file.ts
│   │   ├── run-command.ts
│   │   ├── memory-save.ts
│   │   └── memory-search.ts
│   ├── session.ts            # 会话持久化
│   ├── memory.ts             # 长期记忆
│   ├── system-prompt.ts      # System Prompt 构建
│   ├── compaction.ts         # 上下文压缩
│   ├── agent-loop.ts         # Agent 主循环
│   ├── server.ts             # HTTP + SSE 服务器
│   ├── public/index.html     # Web UI
│   └── index.ts              # CLI REPL 入口
├── tsconfig.json
├── package.json
├── README.md
└── PLAN.md                   # 原始规划
```

## 验证过的场景

1. 纯文本对话
2. 单工具调用（`run_command` 列目录）
3. 连续工具链（`write_file` → `read_file`）
4. 跨会话记忆（先 `memory_save` 保存偏好，新建会话后 `memory_search` 检索）
5. 上下文自动压缩（token 超过阈值时触发）
6. CLI REPL 终端交互
7. Web UI SSE 流式渲染

## 注意事项

- `run_command` 默认工作目录限制在项目根目录，禁止进入 `..` 或访问家目录敏感路径。
- 记忆搜索现在是“任意关键词命中”即返回，并按命中数排序；query 用空格分隔多个关键词。
- 服务默认监听 `0.0.0.0:3000`（Node `http` 默认），CORS 已开放，可直接用浏览器或内嵌预览打开。
- 当前为 MVP，未做身份验证，请勿暴露到公网。
