// 模块 1：Agent Loop — 核心循环引擎
// 调模型 → tool_call → 执行工具 → 追加结果 → 再调模型 → 直到纯文本回复（最多 10 轮）

import type { Message, Tool, ModelConfig, TokenUsage, LogEntry } from "./types";
import { callModel, buildRequestBody, toToolDefinitions } from "./model-client";
import { executeTool } from "./tools";
import { needsCompaction, compactHistory, estimateTokens } from "./compaction";

export const MAX_LOOP_ITERATIONS = 10;

/** 工具结果上限（防止单次工具输出撑爆上下文） */
const TOOL_RESULT_CAP = 20000;

export interface LoopResult {
  reply: string;
  usage: TokenUsage;
}

/**
 * Agent Loop 主函数。
 * messages 为完整历史（含 system），会被原地修改（工具结果、压缩结果都会写回），
 * 调用方保存 session 时直接序列化该数组即可。
 */
export async function runAgentLoop(params: {
  messages: Message[];
  tools: Tool[];
  config: ModelConfig;
  onLog: (e: LogEntry) => void;
}): Promise<LoopResult> {
  const { messages, tools, config, onLog } = params;
  const log = (type: LogEntry["type"], message: string, detail?: any) =>
    onLog({ type, message, detail, ts: new Date().toISOString() });

  const usage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const addUsage = (u: TokenUsage) => {
    usage.prompt_tokens += u.prompt_tokens;
    usage.completion_tokens += u.completion_tokens;
    usage.total_tokens += u.total_tokens;
  };

  // 压缩检查：每次运行前，超阈值自动压缩并同步回原数组
  if (needsCompaction(messages)) {
    const compacted = await compactHistory({ messages, config, onLog });
    messages.length = 0;
    messages.push(...compacted);
  }

  for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
    log("thinking", `正在调用模型（第 ${i + 1} 轮）...`);

    // 完整请求体（供日志展示）
    const requestBody = buildRequestBody({
      model: config.model,
      tools: toToolDefinitions(tools),
      config,
    });
    requestBody.messages = messages;

    let response;
    try {
      response = await callModel({ messages, tools, config });
    } catch (err: any) {
      log("error", `模型调用失败: ${err?.message || err}`);
      throw err;
    }

    log("api_request", `发送请求（${messages.length} 条消息, ${tools.length} 个工具）`, requestBody);
    log(
      "api_response",
      `收到响应${response.message.tool_calls?.length ? `，请求调用 ${response.message.tool_calls.length} 个工具` : ""}`,
      { message: response.message, usage: response.usage }
    );
    addUsage(response.usage);

    const assistant = response.message;

    // 分支 1：模型请求调用工具
    if (assistant.tool_calls && assistant.tool_calls.length > 0) {
      messages.push({
        role: "assistant",
        content: assistant.content ?? null,
        tool_calls: assistant.tool_calls,
      });

      for (const call of assistant.tool_calls) {
        let args: Record<string, any> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        log("tool_call", `调用工具: ${call.function.name}`, { name: call.function.name, arguments: args });

        const raw = await executeTool(call.function.name, args);
        const result = raw.length > TOOL_RESULT_CAP ? raw.slice(0, TOOL_RESULT_CAP) + "\n...(截断)" : raw;

        log("tool_result", `工具 ${call.function.name} 返回（${raw.length} 字符）`, result.slice(0, 500));

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
      continue; // 带工具结果再次调用模型
    }

    // 分支 2：纯文本回复 → 结束循环
    const reply = assistant.content ?? "(空回复)";
    messages.push({ role: "assistant", content: reply });
    log("reply", reply);
    log(
      "token_usage",
      `本次对话 token 用量：输入 ${usage.prompt_tokens} + 输出 ${usage.completion_tokens} = ${usage.total_tokens}`,
      {
        used: estimateTokens(messages),
        prompt: usage.prompt_tokens,
        completion: usage.completion_tokens,
        total: usage.total_tokens,
        max: Number(process.env.COMPACT_MAX_TOKENS || 32000),
      }
    );
    return { reply, usage };
  }

  const msg = `已达最大循环次数 ${MAX_LOOP_ITERATIONS}，强制结束`;
  log("error", msg);
  return { reply: msg, usage };
}
