import { openai } from "@ai-sdk/openai";
import { Output, generateText, jsonSchema } from "ai";

export const REASONING_MODEL = process.env.OPENAI_REASONING_MODEL ?? "gpt-5.1";
export const GENERATION_MODEL = process.env.OPENAI_GENERATION_MODEL ?? "gpt-5.4-mini";

export async function callJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
  const { output } = await generateText({
    model: openai(REASONING_MODEL),
    output: Output.object({ schema: jsonSchema(schema) }),
    prompt,
    telemetry: { functionId: "agent-call-json" },
  });
  if (output === undefined || output === null) {
    throw new Error(`${REASONING_MODEL} returned no structured output`);
  }
  return output as T;
}

export async function generate(system: string, user: string): Promise<string> {
  const { text } = await generateText({
    model: openai(GENERATION_MODEL),
    system,
    prompt: user,
    telemetry: { isEnabled: false },
  });
  if (text.trim().length === 0) {
    throw new Error(`${GENERATION_MODEL} returned no content`);
  }
  return text.trim();
}
