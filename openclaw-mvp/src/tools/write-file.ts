// 内置工具：写文件

import { writeFile, mkdir } from "fs/promises";
import { dirname } from "path";
import type { Tool } from "../types";

export const writeFileTool: Tool = {
  name: "write_file",
  description: "把文本内容写入指定路径的文件（自动创建父目录，覆盖已有内容）。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径（相对或绝对路径）" },
      content: { type: "string", description: "要写入的完整文本内容" },
    },
    required: ["path", "content"],
  },
  async execute(params) {
    const path: string = params.path;
    const content: string = params.content ?? "";
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    return `OK: 已写入 ${content.length} 个字符到 ${path}`;
  },
};
