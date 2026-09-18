// 内置工具：搜索记忆

import type { Tool } from "../types";
import { searchMemory } from "../memory";

export const memorySearchTool: Tool = {
  name: "memory_search",
  description:
    "搜索长期记忆（跨会话保存的偏好、决定、关键事实）。query 中的关键词按空格分隔，任意命中即可返回最相关行。当用户问起之前聊过的内容、偏好、决定时，先用这个工具搜索。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词，如：喜欢 语言" },
    },
    required: ["query"],
  },
  async execute(params) {
    const hits = await searchMemory(String(params.query ?? ""));
    if (hits.length === 0) return "(没有匹配的记忆)";
    return hits.join("\n");
  },
};
