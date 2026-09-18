// 模块 4：System Prompt Builder — 3 段结构：身份 + 工具描述 + 上下文
// 注意：上下文中不包含时间（AI 需要时间应通过工具获取）

import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { Tool } from "./types";

export const INSTRUCTIONS_PATH = join(homedir(), ".agent", "instructions.md");

export interface SystemPromptResult {
  content: string;
  instructionsPath: string;
  loadedInstructions: boolean;
}

export async function buildSystemPrompt(tools: Tool[]): Promise<SystemPromptResult> {
  const sections: string[] = [];

  // ── 第 1 段：身份 + 记忆系统使用指令 ──────────────────────
  sections.push(
    [
      "# Identity",
      "你是 OpenClaw MVP —— 一个运行在用户本地的 AI 助手，可以通过工具读写文件、执行命令、管理长期记忆。",
      "",
      "# Memory Instructions",
      "- 当用户提到偏好、重要决定、关键事实、待办事项时，主动调用 memory_save 保存（不需要用户明确要求\"记住\"）。",
      "- 当用户问起之前聊过的内容、偏好、决定时，先用 memory_search 搜索，再基于搜索结果回答。",
      "- 回答与历史相关的问题时，先搜索记忆，不要凭空猜测。",
    ].join("\n")
  );

  // ── 第 2 段：工具清单（自动从 Tool 列表生成） ─────────────
  const toolLines = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  sections.push(["# Tools", toolLines].join("\n"));

  // ── 第 3 段：上下文（工作目录 + 自定义指令；不含时间） ────
  const ctx: string[] = ["# Context", `- 当前工作目录: ${process.cwd()}`];
  let loadedInstructions = false;
  let custom = "";
  try {
    custom = await readFile(INSTRUCTIONS_PATH, "utf-8");
    if (custom.trim()) {
      loadedInstructions = true;
      ctx.push("", "# Custom Instructions", custom.trim());
    }
  } catch {
    /* 无自定义指令文件，忽略 */
  }
  sections.push(ctx.join("\n"));

  return {
    content: sections.join("\n\n"),
    instructionsPath: INSTRUCTIONS_PATH,
    loadedInstructions,
  };
}
