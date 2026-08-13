import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { ObjectId } from "mongodb";
import { closeDb, promptVersionsCol, promptsCol, spansCol, tracesCol } from "@uberprompt/sdk";
import { ensureTracingIndexes, registerUberprompt, withPrompt } from "../src/index";

const SERVICE = "live-test";
const PROMPT_NAME = "live-triage-router";
const MODEL = "gpt-5-nano";

async function seedPrompt(): Promise<void> {
  const template = "{{role}}\n{{task}}";
  const fragments = [
    { key: "role", text: "You are a support triage router." },
    { key: "task", text: "Route the ticket to billing, tech, or escalation. Answer with the queue name only." },
  ];
  await promptsCol().deleteMany({ name: PROMPT_NAME });
  await promptVersionsCol().deleteMany({ promptName: PROMPT_NAME });

  const versionId = new ObjectId();
  const base = {
    name: PROMPT_NAME,
    version: 1,
    description: "live smoke prompt",
    fragments,
    template,
    updatedAt: new Date(),
    updatedBy: "smoke-live",
  };
  await promptsCol().insertOne({ ...base });
  await promptVersionsCol().insertOne({
    _id: versionId,
    ...base,
    promptName: PROMPT_NAME,
    contentHash: "live-hash",
    frozenAt: new Date(),
  });
}

async function main(): Promise<void> {
  await spansCol().deleteMany({ service: SERVICE });
  await tracesCol().deleteMany({ service: SERVICE });
  await ensureTracingIndexes();
  await seedPrompt();

  const uberprompt = registerUberprompt({ service: SERVICE, flushIntervalMs: 200 });

  const result = await withPrompt(PROMPT_NAME, () =>
    generateText({
      model: openai(MODEL),
      prompt:
        "You are a support triage router. Ticket: 'I was double charged for my subscription this month.' Route to billing, tech, or escalation. Answer with the queue name only.",
      telemetry: { functionId: "live-route" },
    }),
  );

  console.log("model output:", JSON.stringify(result.text));
  console.log(
    "usage:",
    JSON.stringify({
      input: result.usage.inputTokens,
      output: result.usage.outputTokens,
    }),
  );

  await uberprompt.forceFlush();

  const spans = await spansCol().find({ service: SERVICE }).sort({ startTime: 1 }).toArray();
  console.log(`\n${spans.length} span(s) in Mongo:`);
  for (const span of spans) {
    const bound = span.prompt === undefined ? "unbound" : `${span.prompt.name}@${span.prompt.version}`;
    const usage = span.genAi?.usage;
    const tokens = usage === undefined ? "-" : `${usage.inputTokens ?? 0}/${usage.outputTokens ?? 0}`;
    console.log(
      `  ${span.name.padEnd(34)} model=${String(span.genAi?.responseModel ?? span.genAi?.requestModel ?? "-").padEnd(24)} tokens=${tokens.padEnd(10)} ${bound}`,
    );
  }

  const traces = await tracesCol().find({ service: SERVICE }).toArray();
  console.log(`\n${traces.length} rollup trace(s):`);
  for (const trace of traces) {
    console.log(
      `  traceId=${trace.traceId.slice(0, 12)} prompt=${trace.promptName}@${trace.promptVersion} model=${trace.meta.model} latencyMs=${trace.meta.latencyMs} output=${JSON.stringify(trace.output).slice(0, 60)}`,
    );
  }

  if (spans.length === 0 || traces.length === 0) {
    throw new Error("live smoke failed: no spans or traces written to Mongo");
  }

  await uberprompt.shutdown();
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
