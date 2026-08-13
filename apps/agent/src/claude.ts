import Anthropic from "@anthropic-ai/sdk";

export const REASONING_MODEL = "claude-opus-5";
export const GENERATION_MODEL = "claude-haiku-4-5";

let client: Anthropic | undefined;

export function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export async function callJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
  const response = await getClient().beta.messages.create({
    model: REASONING_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error(`Claude refused the request (${response.stop_details?.category ?? "unknown"})`);
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text) throw new Error(`Claude returned no text block (stop_reason=${response.stop_reason})`);
  return JSON.parse(text.text) as T;
}

export async function generate(system: string, user: string): Promise<string> {
  const response = await getClient().messages.create({
    model: GENERATION_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error(`Claude returned no text block (stop_reason=${response.stop_reason})`);
  }
  return text.text.trim();
}
