// 模块 6：CLI Interface — REPL 模式
// 用法: GLM_API_KEY=xxx npx tsx src/index.ts [--session <id>] [--model <model>]

import readline from "readline/promises";
import type { Message, ModelConfig, LogEntry } from "./types";
import { runAgentLoop } from "./agent-loop";
import { registerTools, getAllTools } from "./tools";
import { readFileTool } from "./tools/read-file";
import { writeFileTool } from "./tools/write-file";
import { runCommandTool } from "./tools/run-command";
import { memorySearchTool } from "./tools/memory-search";
import { memorySaveTool } from "./tools/memory-save";
import { buildSystemPrompt } from "./system-prompt";
import { loadSession, saveSession, newSessionId, getCurrentSessionId } from "./session";

// ── 参数解析 ──
function parseArgs(): { session?: string; model?: string } {
  const args = process.argv.slice(2);
  const out: { session?: string; model?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session") out.session = args[++i];
    else if (args[i] === "--model") out.model = args[++i];
  }
  return out;
}

const args = parseArgs();

const config: ModelConfig = {
  apiKey: process.env.GLM_API_KEY || "",
  baseUrl: process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
  model: args.model || process.env.GLM_MODEL || "glm-5.3",
  reasoningEffort: process.env.GLM_EFFORT || "low",
  maxTokens: Number(process.env.GLM_MAX_TOKENS || 8192),
};

if (!config.apiKey) {
  console.error("缺少 GLM_API_KEY 环境变量。用法: GLM_API_KEY=你的key npx tsx src/index.ts");
  process.exit(1);
}

// ── 初始化 ──
registerTools([readFileTool, writeFileTool, runCommandTool, memorySearchTool, memorySaveTool]);
const promptResult = await buildSystemPrompt(getAllTools());

const sessionId = args.session || (await getCurrentSessionId());
const history: Message[] = await loadSession(sessionId);
history.unshift({ role: "system", content: promptResult.content });

// ── 日志打印（终端简洁版） ──
function printLog(e: LogEntry) {
  const icons: Record<string, string> = {
    thinking: "·",
    api_request: "→",
    api_response: "←",
    tool_call: "🔧",
    tool_result: "✓",
    reply: "",
    error: "✗",
    compaction: "🗜",
    token_usage: "⏱",
    info: "ℹ",
  };
  if (e.type === "reply") return; // 回复单独打印
  const icon = icons[e.type] || "·";
  console.log(`  ${icon} ${e.message}`);
}

// ── REPL ──
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`OpenClaw MVP CLI · model=${config.model} · session=${sessionId}`);
console.log(`消息 ${history.length} 条 | /exit 退出 | 工具: ${getAllTools().map((t) => t.name).join(", ")}`);
console.log("");

while (true) {
  const input = await rl.question("你> ").catch(() => null);
  if (input === null) break; // EOF/Ctrl+C
  const text = input.trim();
  if (!text) continue;
  if (text === "/exit" || text === "/quit") break;

  history.push({ role: "user", content: text });
  try {
    const result = await runAgentLoop({
      messages: history,
      tools: getAllTools(),
      config,
      onLog: printLog,
    });
    console.log(`\nAI> ${result.reply}\n`);
    const saved = await saveSession(sessionId, history);
    console.log(`  ℹ session 已保存到 ${saved}\n`);
  } catch (err: any) {
    console.error(`  ✗ 出错: ${err?.message || err}\n`);
  }
}

rl.close();
console.log("bye");
