import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5";

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

async function callJson<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
  const response = await getClient().beta.messages.create({
    model: MODEL,
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

export interface FragmentFix {
  fragment: string | null;
  newText: string;
  reason: string;
}

const fragmentFixSchema = {
  type: "object",
  properties: {
    fragment: { anyOf: [{ type: "string" }, { type: "null" }] },
    newText: { type: "string" },
    reason: { type: "string" },
  },
  required: ["fragment", "newText", "reason"],
  additionalProperties: false,
};

export interface DependentPromptInput {
  name: string;
  fragments: Array<{ key: string; text: string }>;
}

export async function proposeConsistencyFix(args: {
  editedPrompt: string;
  editedFragment: string;
  oldText: string;
  newText: string;
  dependent: DependentPromptInput;
}): Promise<FragmentFix> {
  const prompt = [
    `Fragment "${args.editedFragment}" of prompt "${args.editedPrompt}" was just edited.`,
    `OLD TEXT:\n${args.oldText}`,
    `NEW TEXT:\n${args.newText}`,
    ``,
    `The prompt "${args.dependent.name}" depends on it. Its fragments:`,
    ...args.dependent.fragments.map((f) => `[${f.key}]\n${f.text}`),
    ``,
    `Pick the single fragment of "${args.dependent.name}" that is now inconsistent with the edit and rewrite it minimally so it agrees with the NEW TEXT. Keep its structure and intent.`,
    `Return JSON: fragment = the key you rewrote (null if nothing needs to change), newText = full rewritten fragment text ("" if fragment is null), reason = one sentence.`,
  ].join("\n");
  return callJson<FragmentFix>(prompt, fragmentFixSchema);
}

export interface LessonCandidate {
  text: string;
  appliesTo: string[];
}

export async function analyzeTraceBatch(
  traces: Array<{
    promptName: string;
    promptVersion: number;
    score?: number;
    error?: string;
    input: string;
    output: string;
  }>,
  knownPrompts: string[],
): Promise<LessonCandidate[]> {
  const schema = {
    type: "object",
    properties: {
      lessons: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            appliesTo: { type: "array", items: { type: "string" } },
          },
          required: ["text", "appliesTo"],
          additionalProperties: false,
        },
      },
    },
    required: ["lessons"],
    additionalProperties: false,
  };
  const prompt = [
    `You analyze production LLM traces for a prompt-management system.`,
    `Known prompt names: ${knownPrompts.join(", ")}`,
    ``,
    `Traces (failures have an error field or score < 0.5):`,
    JSON.stringify(traces, null, 2),
    ``,
    `Look for recurring failure patterns or durable insights that should change how prompts are written.`,
    `Return JSON {lessons: [...]}. Each lesson: text = one concrete, durable, actionable insight (not a restatement of a single trace); appliesTo = the known prompt names it applies to.`,
    `Return an empty lessons array if nothing durable emerges. Be conservative: at most 2 lessons.`,
  ].join("\n");
  const result = await callJson<{ lessons: LessonCandidate[] }>(prompt, schema);
  return result.lessons.filter((l) => l.appliesTo.some((p) => knownPrompts.includes(p)));
}

export async function applyLessonToPrompt(args: {
  lesson: string;
  prompt: DependentPromptInput;
}): Promise<FragmentFix> {
  const prompt = [
    `A lesson was learned from production traces:`,
    args.lesson,
    ``,
    `Apply it to prompt "${args.prompt.name}". Its fragments:`,
    ...args.prompt.fragments.map((f) => `[${f.key}]\n${f.text}`),
    ``,
    `Pick the single fragment that should change to incorporate the lesson and rewrite it minimally. Keep its structure and intent.`,
    `Return JSON: fragment = the key you rewrote (null if the lesson does not apply), newText = full rewritten fragment text ("" if fragment is null), reason = one sentence referencing the lesson.`,
  ].join("\n");
  return callJson<FragmentFix>(prompt, fragmentFixSchema);
}
