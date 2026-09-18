// 内置工具：执行 shell 命令（30 秒超时）

import { exec } from "child_process";
import type { Tool } from "../types";

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "在当前工作目录执行一条 shell 命令并返回 stdout/stderr。用于查看目录、运行脚本、git 操作等。命令超时 30 秒。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令，如 ls、dir、node script.js" },
    },
    required: ["command"],
  },
  async execute(params) {
    const command: string = params.command;
    return new Promise<string>((resolve) => {
      exec(
        command,
        { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          let out = "";
          if (stdout) out += `[stdout]\n${stdout}`;
          if (stderr) out += (out ? "\n" : "") + `[stderr]\n${stderr}`;
          if (err && !stdout && !stderr) {
            out = `Error: ${err.message}`;
          } else if (err && err.killed) {
            out += "\n(命令超时被终止，30s)";
          }
          const MAX = 20000;
          if (out.length > MAX) out = out.slice(0, MAX) + `\n...（截断，共 ${out.length} 字符）`;
          resolve(out || "(无输出)");
        }
      );
    });
  },
};
