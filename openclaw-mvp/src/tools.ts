// 模块 2：Tool System — 工具注册表 + 执行
// MVP 无包装层/策略层：直接注册、直接执行

import type { Tool } from "./types";

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool);
}

export function registerTools(tools: Tool[]): void {
  for (const t of tools) registerTool(t);
}

export function getAllTools(): Tool[] {
  return Array.from(registry.values());
}

/** 按名字执行工具；失败时返回错误信息字符串而非抛异常（喂回给模型） */
export async function executeTool(name: string, params: Record<string, any>): Promise<string> {
  const tool = registry.get(name);
  if (!tool) {
    return `Error: unknown tool "${name}". Available tools: ${Array.from(registry.keys()).join(", ")}`;
  }
  try {
    let parsed = params;
    if (typeof params === "string") {
      try {
        parsed = params ? JSON.parse(params) : {};
      } catch {
        parsed = {}; // 让 schema 校验去报错
      }
    }
    const result = await tool.execute(parsed || {});
    return result;
  } catch (err: any) {
    return `Error executing tool "${name}": ${err?.message || err}`;
  }
}
