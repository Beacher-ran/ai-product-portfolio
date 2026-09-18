// Phase 3/4/5/6/7：HTTP 服务器（Node 内置 http 模块，零额外依赖）
// GET  /               前端页面
// POST /chat           SSE 流式推送 agent 日志
// GET  /sessions       session 列表 + currentSessionId
// POST /sessions/new   新建会话
// POST /sessions/switch 切换会话（返回历史消息）
// GET  /system-prompt  system prompt + instructions 路径
// GET  /memory         记忆信息

import http from "http";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import type { Message, ModelConfig, LogEntry } from "./types";
import { runAgentLoop } from "./agent-loop";
import { registerTools, getAllTools } from "./tools";
import { readFileTool } from "./tools/read-file";
import { writeFileTool } from "./tools/write-file";
import { runCommandTool } from "./tools/run-command";
import { memorySearchTool } from "./tools/memory-search";
import { memorySaveTool } from "./tools/memory-save";
import { buildSystemPrompt } from "./system-prompt";
import {
  loadSession,
  saveSession,
  listSessions,
  newSessionId,
  getCurrentSessionId,
} from "./session";
import { getMemoryInfo } from "./memory";
import { estimateTokens } from "./compaction";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 配置 ────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3000);
const config: ModelConfig = {
  apiKey: process.env.GLM_API_KEY || "",
  baseUrl: process.env.GLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
  model: process.env.GLM_MODEL || "glm-5.3",
  reasoningEffort: process.env.GLM_EFFORT || "low",
  maxTokens: Number(process.env.GLM_MAX_TOKENS || 8192),
};

if (!config.apiKey) {
  console.error("缺少 GLM_API_KEY 环境变量。启动方式：GLM_API_KEY=你的key npx tsx src/server.ts");
  process.exit(1);
}

// ── 工具注册（5 个内置） ─────────────────────────────────
registerTools([readFileTool, writeFileTool, runCommandTool, memorySearchTool, memorySaveTool]);

// ── System Prompt：启动时构建一次 ────────────────────────
const promptResult = await buildSystemPrompt(getAllTools());
console.log(
  promptResult.loadedInstructions
    ? `[启动] 已加载自定义指令: ${promptResult.instructionsPath}`
    : `[启动] 未发现自定义指令文件（${promptResult.instructionsPath}），使用默认 system prompt`
);

// ── 会话状态 ────────────────────────────────────────────
let currentSessionId = await getCurrentSessionId();
let conversationHistory: Message[] = await loadSession(currentSessionId);
// 保证 system prompt 在最前
function ensureSystemPrompt(history: Message[]): Message[] {
  const rest = history.filter((m) => m.role !== "system");
  return [{ role: "system", content: promptResult.content }, ...rest];
}
conversationHistory = ensureSystemPrompt(conversationHistory);

// ── 工具函数 ────────────────────────────────────────────
async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function cors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: http.ServerResponse, code: number, obj: any) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function sseWrite(res: http.ServerResponse, payload: any) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ── 路由 ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  try {
    // CORS：允许前端从任意来源访问（包含本地文件/iframe 预览）
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // 前端页面
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(join(__dirname, "public", "index.html"), "utf-8");
      cors(res);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // session 列表
    if (req.method === "GET" && url.pathname === "/sessions") {
      const sessions = await listSessions();
      json(res, 200, { sessions, currentSessionId });
      return;
    }

    // 新建会话
    if (req.method === "POST" && url.pathname === "/sessions/new") {
      currentSessionId = newSessionId();
      conversationHistory = ensureSystemPrompt([]);
      await saveSession(currentSessionId, conversationHistory);
      json(res, 200, { sessionId: currentSessionId, messages: [] });
      return;
    }

    // 切换会话
    if (req.method === "POST" && url.pathname === "/sessions/switch") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = String(body.sessionId || "");
      if (!id) {
        json(res, 400, { error: "sessionId required" });
        return;
      }
      currentSessionId = id;
      conversationHistory = ensureSystemPrompt(await loadSession(id));
      await saveSession(id, conversationHistory);
      json(res, 200, { sessionId: id, messages: conversationHistory });
      return;
    }

    // system prompt
    if (req.method === "GET" && url.pathname === "/system-prompt") {
      json(res, 200, promptResult);
      return;
    }

    // 记忆信息
    if (req.method === "GET" && url.pathname === "/memory") {
      json(res, 200, await getMemoryInfo());
      return;
    }

    // 聊天（SSE）
    if (req.method === "POST" && url.pathname === "/chat") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const userMessage = String(body.message || "").trim();
      if (!userMessage) {
        json(res, 400, { error: "message required" });
        return;
      }

      cors(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();

      const onLog = (e: LogEntry) => sseWrite(res, e);

      try {
        onLog({
          type: "info",
          message: `session: ${currentSessionId}`,
          ts: new Date().toISOString(),
        });
        conversationHistory.push({ role: "user", content: userMessage });

        await runAgentLoop({
          messages: conversationHistory,
          tools: getAllTools(),
          config,
          onLog,
        });

        const savedTo = await saveSession(currentSessionId, conversationHistory);
        onLog({
          type: "info",
          message: `session 已保存到 ${savedTo}（当前 ${estimateTokens(conversationHistory)} tokens 估算）`,
          ts: new Date().toISOString(),
        });
      } catch (err: any) {
        onLog({
          type: "error",
          message: `执行失败: ${err?.message || err}`,
          ts: new Date().toISOString(),
        });
      }

      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err: any) {
    json(res, 500, { error: err?.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`OpenClaw MVP server: http://localhost:${PORT}`);
  console.log(`模型: ${config.model} @ ${config.baseUrl}（effort=${config.reasoningEffort}）`);
  console.log(`当前 session: ${currentSessionId}（${conversationHistory.length} 条消息）`);
});
