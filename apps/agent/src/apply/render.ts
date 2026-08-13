import type { PromptDoc } from "@uberprompt/sdk";

const CONTENT_SLOTS = new Set(["ticket", "message", "conversation"]);
const COMPOSED_KEYS = new Set(["ticketId", "subject", "body", "transcript"]);

export function withFragment(doc: PromptDoc, key: string, text: string): PromptDoc {
  if (!doc.fragments.some((f) => f.key === key)) {
    throw new Error(`Fragment "${key}" not found in prompt "${doc.name}"`);
  }
  return {
    ...doc,
    fragments: doc.fragments.map((f) => (f.key === key ? { ...f, text } : { ...f })),
  };
}

export function withOpenSlots(doc: PromptDoc): PromptDoc {
  return {
    ...doc,
    fragments: doc.fragments.map((f) =>
      f.text === "" ? { ...f, text: `{{${f.key}}}` } : { ...f },
    ),
  };
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function composeInput(input: Record<string, unknown>): string {
  const lines: string[] = [];
  if (input.ticketId !== undefined) lines.push(`Ticket ${asText(input.ticketId)}`);
  if (input.subject !== undefined) lines.push(`Subject: ${asText(input.subject)}`);
  if (input.body !== undefined) lines.push(asText(input.body));
  if (input.transcript !== undefined) lines.push(asText(input.transcript));
  for (const [key, value] of Object.entries(input)) {
    if (!COMPOSED_KEYS.has(key)) lines.push(`${key}: ${asText(value)}`);
  }
  return lines.join("\n");
}

export function fillInputs(rendered: string, input: Record<string, unknown>): string {
  const composed = composeInput(input);
  return rendered.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    if (input[key] !== undefined) return asText(input[key]);
    if (CONTENT_SLOTS.has(key)) return composed;
    return "(not provided)";
  });
}
