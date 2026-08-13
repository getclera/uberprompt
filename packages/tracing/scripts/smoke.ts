import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3, mockId } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { closeDb, promptVersionsCol, promptsCol, spansCol, tracesCol } from "@uberprompt/sdk";
import { ensureTracingIndexes, registerUberprompt, withPrompt } from "../src/index";

const PROMPT_NAME = "smoke-triage-router";

async function seedPrompt(): Promise<void> {
  const template = "{{role}}\n{{task}}";
  const fragments = [
    { key: "role", text: "You are a support triage router." },
    { key: "task", text: "Route the ticket to the right queue." },
  ];
  await promptsCol().deleteMany({ name: PROMPT_NAME });
  await promptVersionsCol().deleteMany({ promptName: PROMPT_NAME });

  const versionId = new ObjectId();
  await promptsCol().insertOne({
    name: PROMPT_NAME,
    version: 1,
    description: "smoke test prompt",
    fragments,
    template,
    updatedAt: new Date(),
    updatedBy: "smoke",
  });
  await promptVersionsCol().insertOne({
    _id: versionId,
    promptName: PROMPT_NAME,
    name: PROMPT_NAME,
    version: 1,
    description: "smoke test prompt",
    fragments,
    template,
    contentHash: "smoke-hash",
    updatedAt: new Date(),
    updatedBy: "smoke",
    frozenAt: new Date(),
  });
}

function mockModel(): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      call += 1;
      if (call === 1) {
        return {
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: {
            inputTokens: { total: 812, noCache: 700, cacheRead: 112, cacheWrite: 0 },
            outputTokens: { total: 31, text: 31, reasoning: 0 },
          },
          content: [
            {
              type: "tool-call" as const,
              toolCallId: mockId()(),
              toolName: "lookupQueue",
              input: JSON.stringify({ topic: "billing" }),
            },
          ],
          warnings: [],
        };
      }
      return {
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          inputTokens: { total: 940, noCache: 828, cacheRead: 112, cacheWrite: 0 },
          outputTokens: { total: 18, text: 18, reasoning: 0 },
        },
        content: [{ type: "text" as const, text: "Routed to the billing queue." }],
        warnings: [],
      };
    },
  });
}

async function main(): Promise<void> {
  await spansCol().deleteMany({ service: "smoke-test" });
  await tracesCol().deleteMany({ service: "smoke-test" });
  console.log("cleared previous smoke-test data\n");

  console.log("--- ensuring indexes ---");
  for (const created of await ensureTracingIndexes()) console.log(`  ${created}`);

  await seedPrompt();
  console.log(`\nseeded prompt ${PROMPT_NAME}@1`);

  const uberprompt = registerUberprompt({ service: "smoke-test", flushIntervalMs: 200 });

  const result = await withPrompt(PROMPT_NAME, () =>
    generateText({
      model: mockModel(),
      prompt: "Customer was double charged for their subscription.",
      stopWhen: stepCountIs(3),
      tools: {
        lookupQueue: tool({
          description: "Look up the queue for a topic",
          inputSchema: z.object({ topic: z.string() }),
          execute: async ({ topic }) => ({ queue: `${topic}-tier1` }),
        }),
      },
      telemetry: { functionId: "smoke-route" },
    }),
  );

  console.log("model output:", JSON.stringify(result.text));

  await uberprompt.forceFlush();

  const spans = await spansCol().find({ service: "smoke-test" }).sort({ startTime: 1 }).toArray();
  console.log(`\n--- ${spans.length} spans written ---`);
  for (const span of spans) {
    const parent = span.parentSpanId === undefined ? "root" : `child of ${span.parentSpanId.slice(0, 8)}`;
    const model = span.genAi?.requestModel ?? "-";
    const usage = span.genAi?.usage;
    const tokens = usage === undefined ? "-" : `${usage.inputTokens ?? 0}/${usage.outputTokens ?? 0}`;
    const bound = span.prompt === undefined ? "unbound" : `${span.prompt.name}@${span.prompt.version}`;
    console.log(
      `  ${span.spanId.slice(0, 8)} ${span.name.padEnd(34)} ${parent.padEnd(18)} model=${String(model).padEnd(12)} tokens(in/out)=${String(tokens).padEnd(10)} ${bound}`,
    );
  }

  const traces = await tracesCol().find({ service: "smoke-test" }).toArray();
  console.log(`\n--- ${traces.length} rollup trace(s) ---`);
  console.log(JSON.stringify(traces, null, 2));

  console.log("\n--- $lookup join across the promptVersionId FK ---");
  const joined = await tracesCol()
    .aggregate([
      { $match: { service: "smoke-test" } },
      {
        $lookup: {
          from: "prompt_versions",
          localField: "promptVersionId",
          foreignField: "_id",
          as: "version",
        },
      },
      { $unwind: "$version" },
      {
        $project: {
          _id: 0,
          traceId: 1,
          promptName: 1,
          promptVersion: 1,
          resolvedTemplate: "$version.template",
          resolvedFragments: { $size: "$version.fragments" },
        },
      },
    ])
    .toArray();
  console.log(JSON.stringify(joined, null, 2));

  console.log("\n--- idempotency: re-running the rollup must not duplicate ---");
  const before = await tracesCol().countDocuments({ service: "smoke-test" });
  const { rollupTraces } = await import("../src/rollup");
  await rollupTraces(traces.map((t) => t.traceId));
  const after = await tracesCol().countDocuments({ service: "smoke-test" });
  console.log(`traces before=${before} after=${after} ${before === after ? "OK" : "DUPLICATED"}`);

  await uberprompt.shutdown();
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
