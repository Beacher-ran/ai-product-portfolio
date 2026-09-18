// =====================================================
// AI 文档搭子 - 配置文件示例
// 使用方式：复制本文件为 config.js，填入你自己的 API Key。
// config.js 已在 .gitignore 中排除，不会被提交到仓库。
// =====================================================
module.exports = {
  // 大模型 API Key（也可通过环境变量 GLM_API_KEY 注入）
  // 智谱开放平台：https://open.bigmodel.cn
  API_KEY: process.env.GLM_API_KEY || "",

  // OpenAI Chat Completion 协议端点
  BASE_URL: "https://open.bigmodel.cn/api/paas/v4",

  // 模型
  MODEL: "glm-5.3",

  // GLM 官方不支持禁用思考（thinking.type 仅允许 enabled），
  // reasoning_effort 取 low 即最轻量推理档位。
  THINKING: { type: "enabled" },
  REASONING_EFFORT: "low",

  TEMPERATURE: 0.7,

  // 对话引导与文档生成的最大输出 tokens
  CHAT_MAX_TOKENS: 8192,
  GEN_MAX_TOKENS: 32768,

  // 服务端口
  PORT: 3000
};
