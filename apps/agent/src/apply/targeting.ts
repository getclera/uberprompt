import { promptsCol, type LessonDoc } from "@uberprompt/sdk";
import { callJson } from "../llm";

export type TargetRung = "lineage" | "catalog" | "rag";

export interface TargetHit {
  prompt: string;
  rung: TargetRung;
  score?: number;
  reason: string;
}

export const DESCRIPTIONS_VECTOR_INDEX_NAME = "descriptions_embedding";
export const RAG_MIN_SCORE = 0.75;
export const RAG_LIMIT = 5;

export interface CatalogEntry {
  name: string;
  description: string;
  template: string;
  fragmentKeys: string[];
}

export interface DescriptionHit {
  prompt: string;
  score: number;
}

export interface TargetingDeps {
  callJson: <T>(prompt: string, schema: Record<string, unknown>) => Promise<T>;
  fetchCatalog: () => Promise<CatalogEntry[]>;
  searchDescriptions: (embedding: number[]) => Promise<DescriptionHit[]>;
}

const CATALOG_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          reason: { type: "string" },
        },
        required: ["prompt", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["targets"],
  additionalProperties: false,
};

interface CatalogResponse {
  targets: Array<{ prompt: string; reason: string }>;
}

function defaultDeps(): TargetingDeps {
  return {
    callJson,
    fetchCatalog: async () => {
      const docs = await promptsCol()
        .find({}, { projection: { name: 1, description: 1, template: 1, "fragments.key": 1 } })
        .toArray();
      return docs.map((doc) => ({
        name: doc.name,
        description: doc.description,
        template: doc.template,
        fragmentKeys: doc.fragments.map((fragment) => fragment.key),
      }));
    },
    searchDescriptions: (embedding) =>
      promptsCol()
        .aggregate<DescriptionHit>([
          {
            $vectorSearch: {
              index: DESCRIPTIONS_VECTOR_INDEX_NAME,
              path: "descriptionEmbedding",
              queryVector: embedding,
              numCandidates: RAG_LIMIT * 20,
              limit: RAG_LIMIT,
            },
          },
          { $project: { _id: 0, prompt: "$name", score: { $meta: "vectorSearchScore" } } },
        ])
        .toArray(),
  };
}

function formatCatalogEntry(entry: CatalogEntry): string {
  return [
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `template: ${entry.template}`,
    `fragment keys: ${entry.fragmentKeys.join(", ")}`,
  ].join("\n");
}

function buildCatalogPrompt(
  lesson: LessonDoc,
  catalog: CatalogEntry[],
  alreadyTargeted: string[],
): string {
  const sections = [
    "A production lesson was mined from failing LLM traces. Decide which prompts in the catalog below this lesson ALSO applies to — prompts whose instructions restate, depend on, or contradict the rule the lesson teaches.",
    `Lesson: ${lesson.text}`,
  ];
  if (lesson.reason) sections.push(`Lesson reason: ${lesson.reason}`);
  if (alreadyTargeted.length > 0) {
    sections.push(`Already targeted, do not repeat: ${alreadyTargeted.join(", ")}`);
  }
  sections.push(`Prompt catalog:\n\n${catalog.map(formatCatalogEntry).join("\n\n")}`);
  sections.push(
    'Return JSON with "targets": one entry per additional prompt the lesson applies to, with "prompt" copied exactly from a catalog name and a one-sentence human-readable "reason" explaining why the lesson applies to it. Return an empty array if it applies to no additional prompts.',
  );
  return sections.join("\n\n");
}

export async function targetPrompts(
  lesson: LessonDoc,
  deps: TargetingDeps = defaultDeps(),
): Promise<TargetHit[]> {
  const hits: TargetHit[] = [];
  const seen = new Set<string>();

  for (const prompt of lesson.appliesTo) {
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    hits.push({ prompt, rung: "lineage", reason: "produced the failing traces behind this lesson" });
  }

  const catalog = await deps.fetchCatalog();
  const knownPrompts = new Set(catalog.map((entry) => entry.name));

  if (catalog.length > 0) {
    const response = await deps.callJson<CatalogResponse>(
      buildCatalogPrompt(lesson, catalog, [...seen]),
      CATALOG_SCHEMA,
    );
    for (const target of response.targets) {
      if (!knownPrompts.has(target.prompt) || seen.has(target.prompt)) continue;
      seen.add(target.prompt);
      hits.push({ prompt: target.prompt, rung: "catalog", reason: target.reason });
    }
  }

  const ragHits = await deps.searchDescriptions(lesson.embedding);
  for (const hit of ragHits) {
    if (hit.score < RAG_MIN_SCORE) continue;
    if (!knownPrompts.has(hit.prompt) || seen.has(hit.prompt)) continue;
    seen.add(hit.prompt);
    hits.push({
      prompt: hit.prompt,
      rung: "rag",
      score: hit.score,
      reason: `${hit.score.toFixed(2)} similarity to lesson`,
    });
  }

  return hits;
}
