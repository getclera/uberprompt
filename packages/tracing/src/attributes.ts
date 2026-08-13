export const GEN_AI = {
  operation: "gen_ai.operation.name",
  provider: "gen_ai.provider.name",
  system: "gen_ai.system",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  responseId: "gen_ai.response.id",
  finishReasons: "gen_ai.response.finish_reasons",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  cacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
} as const;

export const AI_SDK = {
  operationId: "ai.operationId",
  prompt: "ai.prompt",
  promptMessages: "ai.prompt.messages",
  responseText: "ai.response.text",
  responseObject: "ai.response.object",
} as const;

export const UBERPROMPT = {
  name: "uberprompt.prompt.name",
  version: "uberprompt.prompt.version",
  versionId: "uberprompt.prompt.version_id",
  contentHash: "uberprompt.prompt.content_hash",
} as const;

export const OPERATION_NAMES = {
  invokeAgent: "invoke_agent",
  chat: "chat",
  executeTool: "execute_tool",
} as const;
