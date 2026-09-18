// 内置工具：保存记忆

import type { Tool } from "../types";
import { saveMemory } from "../memory";

export const memorySaveTool: Tool = {
  name: "memory_save",
  description:
    "把一条重要信息保存到长期记忆（跨会话持久化）。当用户提到偏好、重要决定、关键事实、待办事项时，主动调用此工具保存，不需要用户明确要求记住。content 用一句简洁的陈述句。",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "要记住的内容，如：用户喜欢用 TypeScript 写项目" },
    },
    required: ["content"],
  },
  async execute(params) {
    await saveMemory(String(params.content ?? ""));
    return `OK: 已保存到长期记忆: ${params.content}`;
  },
};
