import {
  loadEnv,
  requireEnv,
  connect,
  openaiClient,
  structuredCall,
  truncate,
} from "./store.mjs";

const DEFAULT_MODEL = "gpt-5.1";
const RAG_INDEX = "descriptions_embedding";
const RAG_MIN_SCORE = 0.7;
const RAG_LIMIT = 5;

const CATALOG_TOOL = {
  name: "report_applicable_prompts",
  description:
    "Report which prompts from the catalog a production lesson applies to. Only name prompts whose instructions would actually change if the lesson were folded in.",
  parameters: {
    type: "object",
    properties: {
      prompts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            reason: { type: "string" },
          },
          required: ["name", "reason"],
        },
      },
    },
    required: ["prompts"],
  },
};

function rewriteTool(keys) {
  return {
    name: "propose_fragment_edits",
    description:
      "Propose the minimal fragment rewrites needed to fold a production lesson into a prompt. Return an empty list if the prompt already complies.",
    parameters: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fragment: { type: "string", enum: keys },
              newText: { type: "string" },
              reason: { type: "string" },
            },
            required: ["fragment", "newText", "reason"],
          },
        },
      },
      required: ["edits"],
    },
  };
}

function catalogListing(prompts) {
  return prompts
    .map((p) => {
      const desc = p.description ? `\n  description: ${p.description}` : "";
      const keys = p.fragments.map((f) => f.key).join(", ");
      return `- name: ${p.name}${desc}\n  template: ${JSON.stringify(p.template)}\n  fragment keys: ${keys}`;
    })
    .join("\n");
}

async function catalogTargets(ai, model, prompts, lesson) {
  const prompt =
    "A production lesson was learned from LLM traces. Given the full prompt catalog, " +
    "pick the prompts this lesson applies to — prompts whose instructions would have to " +
    "change to honor the lesson. Be conservative: an unrelated prompt is worse than a miss.\n\n" +
    `Lesson: ${lesson.text}\n` +
    (lesson.reason ? `Why it was learned: ${lesson.reason}\n` : "") +
    "\nPrompt catalog:\n" +
    catalogListing(prompts);
  const out = await structuredCall(ai, model, prompt, CATALOG_TOOL);
  return (out.prompts || []).map((p) => p.name);
}

async function ragTargets(db, prompts, lesson) {
  if (!prompts.some((p) => Array.isArray(p.descriptionEmbedding))) {
    console.error("  RAG rung SKIPPED: no prompt has descriptionEmbedding");
    return [];
  }
  if (!Array.isArray(lesson.embedding)) {
    console.error(`  RAG rung SKIPPED: lesson ${lesson._id} has no embedding`);
    return [];
  }
  try {
    const hits = await db
      .collection("prompts")
      .aggregate([
        {
          $vectorSearch: {
            index: RAG_INDEX,
            path: "descriptionEmbedding",
            queryVector: lesson.embedding,
            numCandidates: 100,
            limit: RAG_LIMIT,
          },
        },
        { $project: { name: 1, score: { $meta: "vectorSearchScore" } } },
      ])
      .toArray();
    return hits.filter((h) => h.score >= RAG_MIN_SCORE).map((h) => h.name);
  } catch (err) {
    console.error(`  RAG rung SKIPPED: $vectorSearch failed: ${err.message}`);
    return [];
  }
}

async function proposeEdits(ai, model, promptDoc, lesson) {
  const editable = promptDoc.fragments.filter((f) => f.text);
  const listing = editable
    .map((f) => `- key: ${f.key}\n  text: ${JSON.stringify(f.text)}`)
    .join("\n");
  const prompt =
    "Fold a production lesson into this prompt with the SMALLEST possible edit.\n\n" +
    `Lesson: ${lesson.text}\n` +
    (lesson.reason ? `Why it was learned: ${lesson.reason}\n` : "") +
    `\nPrompt: ${promptDoc.name}\n` +
    `Template: ${JSON.stringify(promptDoc.template)}\n` +
    `Fragments:\n${listing}\n\n` +
    "Pick the fragment(s) whose text must change and return the complete new text for " +
    "each. Change as little wording as possible — preserve everything the lesson does " +
    "not require changing. The `fragment` field must be one of the listed keys, never " +
    "the fragment text. If the prompt already complies with the lesson, return no edits.";
  const out = await structuredCall(
    ai,
    model,
    prompt,
    rewriteTool(editable.map((f) => f.key))
  );
  const seen = new Set();
  const edits = [];
  for (const e of out.edits || []) {
    if (seen.has(e.fragment)) continue;
    seen.add(e.fragment);
    edits.push(e);
  }
  return edits;
}

async function fileProposal(db, promptDoc, edit, lesson, dryRun) {
  const frag = promptDoc.fragments.find((f) => f.key === edit.fragment);
  if (!frag) {
    console.error(`    unknown fragment "${edit.fragment}" — dropped`);
    return 0;
  }
  if (!frag.text) {
    console.error(`    fragment "${edit.fragment}" is a runtime input slot — dropped`);
    return 0;
  }
  if (edit.newText === frag.text) {
    console.log(`    ${edit.fragment}: no-op edit — skipped`);
    return 0;
  }
  const duplicate = await db.collection("proposals").findOne({
    "target.prompt": promptDoc.name,
    "target.fragment": edit.fragment,
    newText: edit.newText,
    status: "pending",
  });
  if (duplicate) {
    console.log(`    ${edit.fragment}: identical pending proposal ${duplicate._id} — skipped`);
    return 0;
  }
  const proposal = {
    target: { prompt: promptDoc.name, fragment: edit.fragment },
    oldText: frag.text,
    newText: edit.newText,
    reason: edit.reason,
    source: { type: "lesson", ref: lesson._id },
    status: "pending",
    ts: new Date(),
  };
  if (dryRun) {
    console.log(`    would file ${promptDoc.name}.${edit.fragment}: ${truncate(edit.reason, 90)}`);
    return 1;
  }
  const { insertedId } = await db.collection("proposals").insertOne(proposal);
  console.log(`    filed ${insertedId} for ${promptDoc.name}.${edit.fragment}`);
  return 1;
}

export async function runPropose(repoRoot, opts) {
  const env = loadEnv(repoRoot);
  requireEnv(env, ["MONGODB_URI", "MONGODB_DB", "OPENAI_API_KEY"]);
  const model = opts.model || DEFAULT_MODEL;
  const dryRun = Boolean(opts["dry-run"]);
  const { client, db } = await connect(env);
  try {
    const lessons = await db
      .collection("lessons")
      .find({ processedAt: { $exists: false }, status: { $ne: "superseded" } })
      .sort({ ts: 1 })
      .toArray();
    if (lessons.length === 0) {
      console.log("No unprocessed lessons.");
      return 0;
    }
    const prompts = await db.collection("prompts").find({}).toArray();
    if (prompts.length === 0) {
      throw new Error("prompts collection is empty — seed prompts before proposing");
    }
    const byName = new Map(prompts.map((p) => [p.name, p]));
    const ai = await openaiClient(env);
    let totalFiled = 0;

    for (const lesson of lessons) {
      console.log(`\nlesson ${lesson._id}: ${truncate(lesson.text, 110)}`);
      const targets = new Map();
      for (const name of lesson.appliesTo || []) {
        if (byName.has(name)) targets.set(name, "lineage");
        else console.error(`  lineage target "${name}" not in prompts — skipped`);
      }
      for (const name of await catalogTargets(ai, model, prompts, lesson)) {
        if (byName.has(name) && !targets.has(name)) targets.set(name, "catalog");
      }
      for (const name of await ragTargets(db, prompts, lesson)) {
        if (byName.has(name) && !targets.has(name)) targets.set(name, "rag");
      }
      if (targets.size === 0) console.log("  no target prompts found");

      let filed = 0;
      for (const [name, rung] of targets) {
        console.log(`  target ${name} [${rung}]`);
        const edits = await proposeEdits(ai, model, byName.get(name), lesson);
        if (edits.length === 0) console.log("    already complies — no edits");
        for (const edit of edits) {
          filed += await fileProposal(db, byName.get(name), edit, lesson, dryRun);
        }
      }
      totalFiled += filed;
      if (dryRun) {
        console.log(`  dry-run: ${filed} proposal(s) would be filed; lesson left unprocessed`);
      } else {
        await db
          .collection("lessons")
          .updateOne({ _id: lesson._id }, { $set: { processedAt: new Date() } });
        console.log(`  processedAt stamped (${filed} proposal(s) filed)`);
      }
    }
    console.log(
      `\n${dryRun ? "dry-run: " : ""}${lessons.length} lesson(s), ${totalFiled} proposal(s)${dryRun ? " would be" : ""} filed`
    );
    return 0;
  } finally {
    await client.close();
  }
}
