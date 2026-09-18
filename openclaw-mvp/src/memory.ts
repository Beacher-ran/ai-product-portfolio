// 模块 8：Memory System — 长期记忆（Markdown 文件 + 关键词搜索）
// 存储位置：~/.agent/memory/（MEMORY.md 为策划记忆，按天日志可自由扩展）

import { readdir, readFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export const MEMORY_DIR = join(homedir(), ".agent", "memory");
export const MEMORY_FILE = join(MEMORY_DIR, "MEMORY.md");

async function ensureDir() {
  await mkdir(MEMORY_DIR, { recursive: true });
}

async function listMemoryFiles(): Promise<string[]> {
  try {
    const files = await readdir(MEMORY_DIR);
    return files.filter((f) => f.endsWith(".md")).map((f) => join(MEMORY_DIR, f));
  } catch {
    return [];
  }
}

/**
 * 关键词搜索：query 按空白切词，任意关键词命中即返回（大小写不敏感）。
 * 按命中关键词数量降序排列，返回 [文件名:行号] 匹配内容。
 */
export async function searchMemory(query: string, maxResults = 10): Promise<string[]> {
  const keywords = query
    .split(/\s+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  if (keywords.length === 0) return [];

  const files = await listMemoryFiles();
  const scored: { text: string; score: number }[] = [];
  for (const file of files) {
    const name = file.split(/[\\/]/).pop() || file;
    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      const score = keywords.reduce((acc, k) => acc + (lower.includes(k) ? 1 : 0), 0);
      if (score > 0) {
        scored.push({ text: `[${name}:${i + 1}] ${lines[i].trim()}`, score });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.text);
}

/** 保存记忆：追加到 MEMORY.md（带时间戳） */
export async function saveMemory(content: string): Promise<void> {
  await ensureDir();
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  await appendFile(MEMORY_FILE, `\n- [${stamp}] ${content.trim()}\n`, "utf-8");
}

/** 记忆统计信息（用于设置面板展示） */
export async function getMemoryInfo(): Promise<{
  fileCount: number;
  totalLines: number;
  content: string;
}> {
  const files = await listMemoryFiles();
  let totalLines = 0;
  for (const f of files) {
    try {
      const c = await readFile(f, "utf-8");
      totalLines += c.split("\n").length;
    } catch {
      /* ignore */
    }
  }
  let content = "";
  try {
    content = await readFile(MEMORY_FILE, "utf-8");
  } catch {
    content = "";
  }
  return { fileCount: files.length, totalLines, content: content.trim() };
}
