import { callJson } from "../claude";
import type { Candidate, Culprit } from "./types";

const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_CHARS = 600;
const MIN_LENGTH_RATIO = 0.5;
const MAX_LENGTH_RATIO = 2;

const CANDIDATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    newText: { type: "string" },
    reason: { type: "string" },
  },
  required: ["newText", "reason"],
  additionalProperties: false,
};

export interface AuthorArgs {
  lessonText: string;
  promptName: string;
  culprit: Culprit;
  baselineText: string;
  siblingFragments: { key: string; text: string }[];
  failingExamples: string[];
  critique?: string;
  previousAttempt?: string;
}

export type AuthorCall = <T>(prompt: string, schema: Record<string, unknown>) => Promise<T>;

function buildPrompt(args: AuthorArgs): string {
  const siblings = args.siblingFragments
    .filter((f) => f.text.trim().length > 0)
    .map((f) => `[${f.key}]\n${f.text}`)
    .join("\n\n");
  const examples = args.failingExamples
    .slice(0, MAX_EXAMPLES)
    .map((e, i) => `Failing example ${i + 1}:\n${e.slice(0, MAX_EXAMPLE_CHARS)}`)
    .join("\n\n");
  const sections = [
    `Rewrite the "${args.culprit.fragment}" fragment of the prompt "${args.promptName}" so it enforces a lesson learned from production failures.`,
    `Lesson: ${args.lessonText}`,
    `Diagnosis: the span "${args.culprit.span}" is the culprit. ${args.culprit.rationale}`,
    `Current fragment text:\n${args.baselineText}`,
  ];
  if (siblings.length > 0) {
    sections.push(`Other fragments of this prompt, for context — do NOT rewrite these:\n\n${siblings}`);
  }
  if (examples.length > 0) sections.push(examples);
  sections.push(
    'Make a MINIMAL edit: preserve the fragment\'s structure, voice, and every unrelated instruction exactly as written; change only what the lesson requires. Do not rewrite from scratch, do not add unrelated guidance, do not restate what sibling fragments already cover. Return JSON with "newText" (the full revised fragment text) and "reason" (one or two sentences on what changed and why).',
  );
  if (args.critique && args.previousAttempt) {
    sections.push(
      `Your previous attempt was rejected by an evaluation judge.\n\nPrevious attempt:\n${args.previousAttempt}\n\nJudge critique: ${args.critique}\n\nDo not start over — keep what worked in the previous attempt and fix the specific regressions the critique names.`,
    );
  }
  return sections.join("\n\n");
}

function validate(candidate: Candidate, baselineText: string, promptName: string): void {
  const trimmed = candidate.newText.trim();
  if (trimmed.length === 0) {
    throw new Error(`Candidate for "${promptName}" is empty after trimming`);
  }
  if (candidate.newText === baselineText) {
    throw new Error(`Candidate for "${promptName}" is identical to the baseline text`);
  }
  const ratio = candidate.newText.length / baselineText.length;
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) {
    throw new Error(
      `Candidate for "${promptName}" is ${candidate.newText.length} chars vs baseline ${baselineText.length}; must stay within ${MIN_LENGTH_RATIO}x-${MAX_LENGTH_RATIO}x`,
    );
  }
}

export async function authorCandidate(
  args: AuthorArgs,
  call: AuthorCall = callJson,
): Promise<Candidate> {
  const candidate = await call<Candidate>(buildPrompt(args), CANDIDATE_SCHEMA);
  validate(candidate, args.baselineText, args.promptName);
  return candidate;
}
