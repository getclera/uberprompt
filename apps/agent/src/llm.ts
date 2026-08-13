import OpenAI from "openai";

export const REASONING_MODEL = process.env.OPENAI_REASONING_MODEL ?? "gpt-5.1";
export const GENERATION_MODEL = process.env.OPENAI_GENERATION_MODEL ?? "gpt-4.1-mini";

let client: OpenAI | undefined;

export function getClient(): OpenAI {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    client = new OpenAI();
  }
  return client;
}

export async function callJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
  const response = await getClient().chat.completions.create({
    model: REASONING_MODEL,
    response_format: {
      type: "json_schema",
      json_schema: { name: "result", schema, strict: true },
    },
    messages: [{ role: "user", content: prompt }],
  });
  const choice = response.choices[0];
  if (!choice) throw new Error(`${REASONING_MODEL} returned no choices`);
  if (choice.message.refusal) {
    throw new Error(`${REASONING_MODEL} refused the request: ${choice.message.refusal}`);
  }
  const content = choice.message.content;
  if (!content) {
    throw new Error(`${REASONING_MODEL} returned no content (finish_reason=${choice.finish_reason})`);
  }
  return JSON.parse(content) as T;
}

export async function generate(system: string, user: string): Promise<string> {
  const response = await getClient().chat.completions.create({
    model: GENERATION_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  const choice = response.choices[0];
  if (!choice) throw new Error(`${GENERATION_MODEL} returned no choices`);
  const content = choice.message.content;
  if (!content) {
    throw new Error(`${GENERATION_MODEL} returned no content (finish_reason=${choice.finish_reason})`);
  }
  return content.trim();
}
