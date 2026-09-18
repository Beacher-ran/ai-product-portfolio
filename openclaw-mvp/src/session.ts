// 模块 3：Session Management — 会话持久化
// 每个 session 一个 JSON 文件：~/.agent/sessions/<id>.json，内容为 OpenAI messages 数组

import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { Message } from "./types";

export const SESSIONS_DIR = join(homedir(), ".agent", "sessions");
const CURRENT_FILE = join(SESSIONS_DIR, "current.txt");
export const MAX_HISTORY = 50; // 超过 50 条触发简单截断

async function ensureDir() {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6);
  return `s-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

/** 加载 session；不存在返回空数组 */
export async function loadSession(id: string): Promise<Message[]> {
  try {
    const raw = await readFile(join(SESSIONS_DIR, `${id}.json`), "utf-8");
    return JSON.parse(raw) as Message[];
  } catch {
    return [];
  }
}

/** 保存 session（截断后落盘） */
export async function saveSession(id: string, messages: Message[]): Promise<string> {
  await ensureDir();
  const truncated = truncateHistory(messages);
  const file = join(SESSIONS_DIR, `${id}.json`);
  await writeFile(file, JSON.stringify(truncated, null, 2), "utf-8");
  await writeFile(CURRENT_FILE, id, "utf-8");
  return file;
}

/** 简单截断：超过 MAX_HISTORY 条时保留 system 消息 + 最近的消息 */
export function truncateHistory(messages: Message[]): Message[] {
  if (messages.length <= MAX_HISTORY) return messages;
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const keep = rest.slice(rest.length - (MAX_HISTORY - system.length));
  return [...system, ...keep];
}

/** 列出所有 session id（按修改时间倒序） */
export async function listSessions(): Promise<{ id: string; mtime: number }[]> {
  try {
    const files = await readdir(SESSIONS_DIR);
    const out: { id: string; mtime: number }[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const { stat } = await import("fs/promises");
      const s = await stat(join(SESSIONS_DIR, f));
      out.push({ id: f.replace(/\.json$/, ""), mtime: s.mtimeMs });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** 读取上次使用的 session id（没有则新建一个） */
export async function getCurrentSessionId(): Promise<string> {
  try {
    const id = (await readFile(CURRENT_FILE, "utf-8")).trim();
    if (id) return id;
  } catch {
    /* ignore */
  }
  return newSessionId();
}
