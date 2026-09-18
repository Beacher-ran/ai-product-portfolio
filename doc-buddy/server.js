// =====================================================
// PRD 搭子 - 后端服务
// Node.js + Express，调用 GLM-5.3（reasoning_effort=low 轻量推理）
// 每次模型调用全量记录日志到 logs/ai-calls-YYYY-MM-DD.jsonl
// =====================================================
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");

const app = express();
app.use(express.json({ limit: "4mb" }));

// ---------- CORS：允许前端以 file:// 或其它端口打开时直接调用接口 ----------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204); // 预检直接放行
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// ---------- 提示词（统一放在 prompts 文件夹） ----------
const PROMPTS = {
  chat: fs.readFileSync(path.join(__dirname, "prompts", "chat-guide.md"), "utf8"),
  brd: fs.readFileSync(path.join(__dirname, "prompts", "generate-brd.md"), "utf8"),
  mrd: fs.readFileSync(path.join(__dirname, "prompts", "generate-mrd.md"), "utf8"),
  prd: fs.readFileSync(path.join(__dirname, "prompts", "generate-prd.md"), "utf8"),
};

// ---------- 文档类型元信息 ----------
// BRD 面向决策层（为什么值得做），MRD 面向产品与市场（凭什么赢），PRD 面向研发（怎么做）
const DOC_TYPES = {
  brd: { key: "brd", label: "BRD", name: "商业需求文档", prompt: "prompts/generate-brd.md", purpose: "generate_brd" },
  mrd: { key: "mrd", label: "MRD", name: "市场需求文档", prompt: "prompts/generate-mrd.md", purpose: "generate_mrd" },
  prd: { key: "prd", label: "PRD", name: "产品需求文档", prompt: "prompts/generate-prd.md", purpose: "generate_prd" },
};
const DEFAULT_DOC_TYPE = "prd";

function resolveDocType(raw) {
  const k = String(raw || "").toLowerCase();
  return DOC_TYPES[k] || DOC_TYPES[DEFAULT_DOC_TYPE];
}

// ---------- 日志 ----------
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logFilePath() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return path.join(LOG_DIR, `ai-calls-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`);
}

function writeLog(entry) {
  try {
    fs.appendFileSync(logFilePath(), JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    console.error("[日志写入失败]", e.message);
  }
}

// ---------- GLM 调用（含全流程日志） ----------
async function callGLM({ purpose, promptFile, messages, maxTokens }) {
  const callId = crypto.randomUUID();
  const params = {
    model: config.MODEL,
    messages,
    thinking: config.THINKING,        // GLM-5.3 强制 enabled，无法禁用
    reasoning_effort: config.REASONING_EFFORT, // low = 最轻量推理
    max_tokens: maxTokens,
    temperature: config.TEMPERATURE,
    stream: false,
  };
  const modelMetadata = {
    model: config.MODEL,
    base_url: config.BASE_URL + "/chat/completions",
    protocol: "OpenAI Chat Completion",
    params: {
      thinking: params.thinking,
      reasoning_effort: params.reasoning_effort,
      max_tokens: params.max_tokens,
      temperature: params.temperature,
      stream: params.stream,
    },
  };

  const started = Date.now();
  let output = null, error = null;

  try {
    const res = await fetch(config.BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.API_KEY,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 2000)}`);
    }
    output = await res.json();
  } catch (e) {
    error = e.message;
  }

  const msg = output && output.choices && output.choices[0] && output.choices[0].message;
  const entry = {
    call_id: callId,
    timestamp: new Date().toISOString(),
    purpose,                                  // chat_guide | generate_brd | generate_mrd | generate_prd
    model_metadata: modelMetadata,            // 调用模型的元数据
    prompts: {                                // 使用的提示词
      prompt_file: promptFile,
      system_prompt: (messages.find((m) => m.role === "system") || {}).content || "",
    },
    input: { messages },                      // 完整输入
    output: output
      ? {
          content: (msg && msg.content) || "",
          reasoning_content: (msg && msg.reasoning_content) || "",
          finish_reason: (output.choices[0] || {}).finish_reason || null,
          usage: output.usage || null,
          raw_response: output,
        }
      : null,                                 // 模型输出
    duration_ms: Date.now() - started,
    status: error ? "error" : "ok",
    error,
  };
  writeLog(entry);

  if (error) throw new Error(error);
  return output;
}

// ---------- 工具：从模型输出中稳健提取 JSON ----------
function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) return null;
  let body = t.slice(s, e + 1);
  // 容错 1：去掉数组/对象元素后的尾逗号（模型常见笔误）
  body = body.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// 从 assistant 历史消息（可能为 JSON 串）里取可读文本
function assistantReadable(content) {
  const j = extractJSON(content);
  if (!j) return content;
  if (j.reply) return j.reply; // 旧版契约
  if (Array.isArray(j.clarification_questions) && j.clarification_questions.length) {
    return j.clarification_questions.join("\n"); // 新版契约
  }
  return content;
}

// 判断已收集信息是否非空（用于「暂无」提示）
function infoEmpty(info) {
  return !info || !Object.values(info).some((v) =>
    Array.isArray(v) ? v.some((x) => x && String(x).trim()) : !!(v && String(v).trim())
  );
}

// ---------- 接口：对话引导（新 5 要素模型） ----------
app.post("/api/chat", async (req, res) => {
  const userMessage = String(req.body.user_message || "").trim();
  const collectedInfo = req.body.collected_info || null;
  const history = Array.isArray(req.body.history) ? req.body.history : [];

  // 最近对话记录：帮助模型消解「第二个」「就这个吧」等指代
  const recent = history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "用户" : "AI"}：${m.role === "assistant" ? assistantReadable(m.content) : m.content}`)
    .join("\n");

  const userPrompt =
    `已收集的需求信息：\n${infoEmpty(collectedInfo) ? "（暂无）" : JSON.stringify(collectedInfo, null, 2)}\n\n` +
    (recent ? `最近对话记录：\n${recent}\n\n` : "") +
    `用户输入：\n${userMessage}`;

  const messages = [
    { role: "system", content: PROMPTS.chat },
    { role: "user", content: userPrompt },
  ];

  try {
    const out = await callGLM({
      purpose: "chat_guide",
      promptFile: "prompts/chat-guide.md",
      messages,
      maxTokens: config.CHAT_MAX_TOKENS,
    });
    const content = (out.choices[0].message && out.choices[0].message.content) || "";
    let parsed = extractJSON(content);
    if (!parsed) {
      parsed = {
        is_complete: false,
        missing_items: [],
        clarification_questions: [content || "（模型未返回有效内容，请重试）"],
        suggestions: [],
        quick_options: [],
        extracted_info: collectedInfo || {},
      };
    }
    res.json({
      ok: true,
      is_complete: !!parsed.is_complete,
      missing_items: Array.isArray(parsed.missing_items) ? parsed.missing_items : [],
      clarification_questions: Array.isArray(parsed.clarification_questions) ? parsed.clarification_questions : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 2) : [],
      quick_options: Array.isArray(parsed.quick_options) ? parsed.quick_options.slice(0, 4) : [],
      extracted_info: parsed.extracted_info || collectedInfo || {},
      assistant_raw: content, // 原始输出，前端放回 history 保证上下文连续
    });
  } catch (e) {
    console.error("[/api/chat]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- 接口：生成文档（BRD / MRD / PRD）----------
app.post("/api/generate", async (req, res) => {
  const info = req.body.info || {};
  const history = Array.isArray(req.body.history) ? req.body.history : [];
  const docType = resolveDocType(req.body.doc_type);

  const transcript = history
    .map((m) => {
      const who = m.role === "user" ? "用户" : "AI";
      const text = m.role === "assistant" ? assistantReadable(m.content) : m.content;
      return `${who}：${text}`;
    })
    .join("\n\n");

  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;

  const userPrompt =
    `当前日期：${today}\n\n` +
    `需求信息：\n\n\`\`\`json\n${JSON.stringify(info, null, 2)}\n\`\`\`\n\n` +
    `对话记录（补充参考）：\n\n${transcript || "（无）"}\n\n请依据以上需求信息，按系统要求输出完整 ${docType.label}。`;

  const messages = [
    { role: "system", content: PROMPTS[docType.key] },
    { role: "user", content: userPrompt },
  ];

  try {
    const out = await callGLM({
      purpose: docType.purpose,
      promptFile: docType.prompt,
      messages,
      maxTokens: config.GEN_MAX_TOKENS,
    });
    const markdown = (out.choices[0].message && out.choices[0].message.content) || "";
    if (!markdown.trim()) {
      return res.status(500).json({ ok: false, error: "模型返回内容为空，请重试" });
    }
    res.json({ ok: true, markdown, doc_type: docType.key, doc_label: docType.label });
  } catch (e) {
    console.error("[/api/generate]", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- 接口：可用的文档类型 ----------
app.get("/api/doc-types", (req, res) => {
  res.json({
    ok: true,
    default: DEFAULT_DOC_TYPE,
    types: Object.values(DOC_TYPES).map((t) => ({
      key: t.key, label: t.label, name: t.name,
    })),
  });
});

// ---------- 健康检查 ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: config.MODEL, reasoning_effort: config.REASONING_EFFORT });
});

// ---------- 启动 ----------
const PORT = config.PORT || 3000;
app.listen(PORT, () => {
  console.log("=====================================================");
  console.log("  AI 文档搭子 已启动（BRD / MRD / PRD）");
  console.log(`  地址:  http://localhost:${PORT}`);
  console.log(`  模型:  ${config.MODEL} (reasoning_effort=${config.REASONING_EFFORT})`);
  console.log(`  日志:  ${path.join(__dirname, "logs")}`);
  console.log("=====================================================");
});
