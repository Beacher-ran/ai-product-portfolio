// 内置工具：读文件

import { readFile } from "fs/promises";
import type { Tool } from "../types";

export const readFileTool: Tool = {
  name: "read_file",
  description: "读取指定路径文件的内容（UTF-8 文本）。用于查看代码、配置、文档等。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径（相对或绝对路径）" },
    },
    required: ["path"],
  },
  async execute(params) {
    const content = await readFile(params.path, "utf-8");
    // 防止单个工具结果撑爆上下文
    const MAX = 30000;
    if (content.length > MAX) {
      return content.slice(0, MAX) + `\n...（截断，共 ${content.length} 字符）`;
    }
    return content;
  },
};
