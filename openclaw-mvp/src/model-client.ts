// 模块 5：Model API Client — OpenAI 兼容 Chat Completions（非流式）
// 对接 GLM（open.bigmodel.cn）/ 任何 OpenAI 兼容端点

import type { Message, Tool, ToolDefinition, ModelConfig, ModelResponse } from "./types";

/** 把 Tool[] 转成 OpenAI function calling 的 ToolDefinition[] */
export function toToolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** 构建请求体（不含 messages，便于日志展示完整结构） */
export function buildRequestBody(params: {
  model: string;
  tools?: ToolDefinition[];
  config: ModelConfig;
}): Record<string, any> {
  const body: Record<string, any> = {
    model: params.model,
    stream: false,
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
    body.tool_choice = "auto";
  }
  // GLM 系列必须显式开启思考（不支持 disabled）
  if (params.model.startsWith("glm")) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = params.config.reasoningEffort || "low";
  }
  body.max_tokens = params.config.maxTokens || 8192;
  return body;
}

/**
 * 调用模型（非流式 stream:false）
 * 返回 assistant 消息（可能含 tool_calls）+ usage
 */
export async function callModel(params: {
  messages: Message[];
  tools?: Tool[];
  config: ModelConfig;
}): Promise<ModelResponse> {
  const { messages, tools, config } = params;

  const body = buildRequestBody({ model: config.model, tools: tools ? toToolDefinitions(tools) : undefined, config });
  body.messages = messages;

  const url = config.baseUrl.replace(/\/$/, "") + "/chat/completions";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    throw new Error(`网络请求失败: ${err?.message || err}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API 错误 HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  if (!choice || !choice.message) {
    throw new Error(`API 返回空响应: ${JSON.stringify(data).slice(0, 300)}`);
  }

  const raw = choice.message;
  const message = {
    role: "assistant" as const,
    content: raw.content ?? null,
    tool_calls: raw.tool_calls,
  };

  const usage = {
    prompt_tokens: data?.usage?.prompt_tokens ?? 0,
    completion_tokens: data?.usage?.completion_tokens ?? 0,
    total_tokens: data?.usage?.total_tokens ?? 0,
  };

  return { message, usage };
}
