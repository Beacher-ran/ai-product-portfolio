// 共享类型定义（模块 1-8 通用）

/** 消息类型 */
export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON 字符串
  };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** JSON Schema（宽松定义，够 OpenAI function calling 用） */
export interface JsonSchema {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  [key: string]: any;
}

/** 工具接口（定义层，模块 2） */
export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema; // OpenAI function calling 格式
  execute: (params: Record<string, any>) => Promise<string>;
}

/** 发给模型的工具定义（转换层，模块 2/5） */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

/** 模型连接配置（模块 5） */
export interface ModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** GLM 系列思考强度：low / high / max */
  reasoningEffort?: string;
  maxTokens?: number;
}

/** token 用量统计 */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** callModel 的返回 */
export interface ModelResponse {
  message: AssistantMessage;
  usage: TokenUsage;
}

/** runAgentLoop 的返回 */
export interface AgentResult {
  reply: string;
  usage: TokenUsage;
}

/** 日志类型（模块 1 onLog + Phase 3 SSE） */
export type LogType =
  | "thinking" // 正在调用模型
  | "api_request" // 发给 AI 的完整请求体
  | "api_response" // AI 返回的原始响应
  | "tool_call" // AI 决定调用的工具
  | "tool_result" // 工具执行结果
  | "reply" // 最终回复
  | "error" // 错误
  | "compaction" // 上下文压缩
  | "token_usage" // token 用量推送
  | "info"; // 提示信息（session 切换等）

export interface LogEntry {
  type: LogType;
  message: string;
  detail?: any;
  ts: string;
}
