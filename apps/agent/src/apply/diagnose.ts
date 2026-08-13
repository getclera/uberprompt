import type { ObjectId } from "mongodb";
import { edgesCol, tracesCol, type LessonDoc, type PromptDoc, type TraceDoc } from "@uberprompt/sdk";
import { callJson } from "../llm";
import type { Culprit } from "./types";

const MAX_EXAMPLES = 3;

const CULPRIT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    fragment: { type: "string" },
    span: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["fragment", "span", "rationale"],
  additionalProperties: false,
};

interface CulpritResponse {
  fragment: string;
  span: string;
  rationale: string;
}

export interface DiagnoseDeps {
  callJson: <T>(prompt: string, schema: Record<string, unknown>) => Promise<T>;
  fetchTraces: (ids: ObjectId[]) => Promise<TraceDoc[]>;
  fetchSharedWith: (fragmentKey: string) => Promise<string[]>;
}

function defaultDeps(): DiagnoseDeps {
  return {
    callJson,
    fetchTraces: (ids) =>
      tracesCol()
        .find({ _id: { $in: ids } })
        .limit(MAX_EXAMPLES)
        .toArray(),
    fetchSharedWith: async (fragmentKey) => {
      const edges = await edgesCol()
        .find({ "to.fragment": fragmentKey, kind: "uses" })
        .toArray();
      return edges.flatMap((e) => (e.from.prompt ? [e.from.prompt] : []));
    },
  };
}

function formatTrace(trace: TraceDoc, index: number): string {
  const lines = [
    `Failing trace ${index + 1}:`,
    `Input: ${JSON.stringify(trace.input)}`,
    `Output: ${trace.output}`,
  ];
  if (trace.error) lines.push(`Error: ${trace.error}`);
  return lines.join("\n");
}

function buildPrompt(
  lesson: LessonDoc,
  doc: PromptDoc,
  traces: TraceDoc[],
  previousFailure?: string,
): string {
  const fragments = doc.fragments
    .filter((f) => f.text.trim().length > 0)
    .map((f) => `[${f.key}]\n${f.text}`)
    .join("\n\n");
  const sections = [
    `A production lesson was learned about the prompt "${doc.name}". Your job is to identify the culprit: the single fragment whose current text is most responsible for the failures, and the exact span within it that should change.`,
    `Lesson: ${lesson.text}`,
  ];
  if (lesson.reason) sections.push(`Lesson reason: ${lesson.reason}`);
  sections.push(`Fragments of "${doc.name}":\n\n${fragments}`);
  if (traces.length > 0) sections.push(traces.map(formatTrace).join("\n\n"));
  sections.push(
    'The culprit is not necessarily the fragment whose topic matches the lesson — if a fragment already enforces the lesson correctly, the real culprit is usually a different fragment that omits or undermines the guard. Return JSON with "fragment" (the exact key of the culprit fragment), "span" (a substring copied VERBATIM, character for character, from that fragment\'s text — the part that should change), and "rationale" (why this fragment and span cause the failures).',
  );
  if (previousFailure) {
    sections.push(
      `Your previous answer was rejected: ${previousFailure} Pick a fragment key that exists and copy the span verbatim from that fragment's text.`,
    );
  }
  return sections.join("\n\n");
}

function validate(response: CulpritResponse, doc: PromptDoc): string | undefined {
  const fragment = doc.fragments.find((f) => f.key === response.fragment);
  if (!fragment) {
    return `fragment "${response.fragment}" does not exist on prompt "${doc.name}".`;
  }
  if (!fragment.text.includes(response.span)) {
    return `span is not a verbatim substring of fragment "${response.fragment}".`;
  }
  return undefined;
}

export async function findCulprit(
  lesson: LessonDoc,
  doc: PromptDoc,
  deps: DiagnoseDeps = defaultDeps(),
): Promise<Culprit> {
  const traces = (await deps.fetchTraces(lesson.sourceTraceIds)).slice(0, MAX_EXAMPLES);

  let failure: string | undefined;
  let response: CulpritResponse | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = await deps.callJson<CulpritResponse>(
      buildPrompt(lesson, doc, traces, failure),
      CULPRIT_SCHEMA,
    );
    failure = validate(candidate, doc);
    if (!failure) {
      response = candidate;
      break;
    }
  }
  if (!response) {
    throw new Error(`Culprit diagnosis failed for "${doc.name}" after retry: ${failure}`);
  }

  const dependents = await deps.fetchSharedWith(response.fragment);
  const sharedWith = [...new Set(dependents.filter((name) => name !== doc.name))];
  const traceIds = traces.flatMap((t) => (t._id ? [t._id] : []));

  return {
    fragment: response.fragment,
    span: response.span,
    rationale: response.rationale,
    sharedWith,
    traceIds,
  };
}
