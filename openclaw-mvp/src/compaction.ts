// 模块 7：Context Compaction — 上下文压缩（基础版）
// 流程：token 估算超 80% 阈值 → 保留最近 3 轮 → 旧消息交给 AI 摘要 → 替换为摘要消息对

import type { Message, ModelConfig, LogEntry } from "./types";
import { callModel } from "./model-client";

export const MAX_TOKENS = Number(process.env.COMPACT_MAX_TOKENS || 32000);
export const COMPACT_THRESHOLD = 0.8;
export const RECENT_TURNS_KEEP = 3;

/** token 估算：字符数 / 2（中英混合粗略估计） */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += JSON.stringify(m).length;
  }
  return Math.ceil(chars / 2);
}

/** 是否超过阈值需要压缩 */
export function needsCompaction(messages: Message[]): boolean {
  return estimateTokens(messages) > MAX_TOKENS * COMPACT_THRESHOLD;
}

/** 找到「保留最近 N 轮」的起始下标（一轮 = 从 user 消息到下一个 user 消息之前） */
function findKeepStart(messages: Message[], turns: number): number {
  const userIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIdx.push(i);
  }
  if (userIdx.length <= turns) return messages.length; // 不足 N 轮，全部保留
  return userIdx[userIdx.length - turns];
}

/** 把消息序列转成可摘要的文本 */
function messagesToTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      lines.push(`用户: ${m.content}`);
    } else if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        lines.push(`助手(调用工具): ${m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join("; ")}`);
      }
      if (m.content) lines.push(`助手: ${m.content}`);
    } else if (m.role === "tool") {
      lines.push(`工具结果: ${m.content.slice(0, 300)}`);
    }
  }
  return lines.join("\n");
}

/**
 * 执行压缩：返回新消息数组（system 永不压缩）。
 * messages 为完整历史（含 system）。
 */
export async function compactHistory(params: {
  messages: Message[];
  config: ModelConfig;
  onLog?: (e: LogEntry) => void;
}): Promise<Message[]> {
  const { messages, config, onLog } = params;
  const log = (message: string, detail?: any) =>
    onLog?.({ type: "compaction", message, detail, ts: new Date().toISOString() });

  const before = estimateTokens(messages);
  log(`token 估算：${before} / ${MAX_TOKENS}，触发压缩`);

  // 分离 system prompt（永不压缩）
  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const keepStart = findKeepStart(nonSystem, RECENT_TURNS_KEEP);
  const older = nonSystem.slice(0, keepStart);
  const recent = nonSystem.slice(keepStart);

  if (older.length === 0) {
    log("没有可压缩的旧消息（轮次不足），跳过");
    return messages;
  }

  log(
    `保留最近 ${RECENT_TURNS_KEEP} 轮（${recent.length} 条消息），压缩前 ${older.length} 条为摘要`
  );

  // 用 AI 摘要旧消息（独立调用，不带 tools）
  const transcript = messagesToTranscript(older);
  const summaryResponse = await callModel({
    config,
    messages: [
      {
        role: "system",
        content:
          "你是上下文压缩器。把下面的对话历史压缩成一份要点摘要，必须保留：关键事实、用户偏好、重要决定、待办事项、涉及的文件路径/标识符、未完成的话题。用简洁的要点列表输出，不要寒暄。",
      },
      { role: "user", content: `请摘要以下对话历史：\n\n${transcript}` },
    ],
  });
  const summary = summaryResponse.message.content || "(摘要为空)";

  const compacted: Message[] = [
    ...system,
    { role: "user", content: "(系统提示：以下是本会话更早对话的自动摘要，供你参考)\n\n" + summary },
    { role: "assistant", content: "好的，我已了解之前的对话要点，可以继续。" },
    ...recent,
  ];

  const after = estimateTokens(compacted);
  log(`压缩完成：${before} tokens → ${after} tokens`);

  return compacted;
}
