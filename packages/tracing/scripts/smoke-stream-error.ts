import { streamText } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { ObjectId } from "mongodb";
import { closeDb, promptVersionsCol, promptsCol, spansCol, tracesCol } from "@uberprompt/sdk";
import { ensureTracingIndexes, registerUberprompt, withPrompt } from "../src/index";

const STREAM_PROMPT = "smoke-stream-writer";
const ERROR_PROMPT = "smoke-error-writer";

async function seedPrompt(name: string): Promise<void> {
  const fragments = [{ key: "role", text: `You are ${name}.` }];
  await promptsCol().deleteMany({ name });
  await promptVersionsCol().deleteMany({ promptName: name });
  const versionId = new ObjectId();
  const base = {
    name,
    version: 1,
    description: "smoke",
    fragments,
    template: "{{role}}",
    updatedAt: new Date(),
    updatedBy: "smoke",
  };
  await promptsCol().insertOne({ ...base });
  await promptVersionsCol().insertOne({
    ...base,
    _id: versionId,
    promptName: name,
    contentHash: "smoke",
    frozenAt: new Date(),
  });
}

function streamingModel(): MockLanguageModelV3 {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: "Escalating " },
    { type: "text-delta", id: "0", delta: "to the " },
    { type: "text-delta", id: "0", delta: "billing team." },
    { type: "text-end", id: "0" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: { total: 640, noCache: 640, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 24, text: 24, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

function failingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("upstream provider returned 529 overloaded");
    },
  });
}

async function main(): Promise<void> {
  await ensureTracingIndexes();
  for (const service of ["smoke-stream", "smoke-error"]) {
    await spansCol().deleteMany({ service });
    await tracesCol().deleteMany({ service });
  }
  await seedPrompt(STREAM_PROMPT);
  await seedPrompt(ERROR_PROMPT);

  const checks: Array<[string, boolean]> = [];

  // One registration per process: OTel honors only the first global tracer provider,
  // so a second registerUberprompt call would silently drop this service's spans.
  const uberprompt = registerUberprompt({ service: "smoke-stream", flushIntervalMs: 200 });

  // --- streaming ---
  const streamed = await withPrompt(STREAM_PROMPT, async () => {
    const result = streamText({
      model: streamingModel(),
      prompt: "Customer is asking about a duplicate charge.",
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    return text;
  });
  console.log("streamed text:", JSON.stringify(streamed));
  await uberprompt.forceFlush();

  const streamTrace = await tracesCol().findOne({ service: "smoke-stream" });
  const streamSpans = await spansCol().find({ service: "smoke-stream" }).toArray();
  console.log(`\n--- streaming: ${streamSpans.length} spans ---`);
  for (const s of streamSpans) {
    console.log(`  ${s.name.padEnd(26)} status=${s.status} tokens=${s.genAi?.usage?.inputTokens ?? "-"}/${s.genAi?.usage?.outputTokens ?? "-"}`);
  }
  console.log(JSON.stringify(streamTrace?.meta, null, 2));

  checks.push(["streaming produced a rollup", streamTrace !== null]);
  checks.push(["streaming captured output text", streamTrace?.output?.includes("billing team") === true]);
  checks.push(["streaming captured tokens", streamTrace?.meta.tokens?.inputTokens === 640]);
  checks.push(["streaming bound the prompt version", streamTrace?.promptName === STREAM_PROMPT]);
  checks.push(["streaming latency is non-zero", (streamTrace?.meta.latencyMs ?? 0) > 0]);

  // --- real thrown error ---
  let threw = false;
  try {
    await withPrompt(ERROR_PROMPT, async () => {
      const { generateText } = await import("ai");
      return generateText({ model: failingModel(), prompt: "This call will fail." });
    });
  } catch {
    threw = true;
  }
  await uberprompt.forceFlush();

  const errorSpans = await spansCol()
    .find({ service: "smoke-stream", "prompt.name": ERROR_PROMPT })
    .toArray();
  const errorTraceId = errorSpans[0]?.traceId;
  const errorTrace =
    errorTraceId === undefined ? null : await tracesCol().findOne({ traceId: errorTraceId });
  console.log(`\n--- error path: ${errorSpans.length} spans ---`);
  for (const s of errorSpans) {
    console.log(`  ${s.name.padEnd(26)} status=${s.status.padEnd(5)} msg=${s.statusMessage ?? "-"}`);
  }
  console.log(JSON.stringify(errorTrace, null, 2));

  checks.push(["the failing call actually threw", threw]);
  checks.push(["error path produced a rollup", errorTrace !== null]);
  checks.push(["at least one span marked error", errorSpans.some((s) => s.status === "error")]);
  checks.push(["rollup surfaced the error message", (errorTrace?.error ?? "").includes("529")]);
  checks.push(["error trace still bound the prompt", errorTrace?.promptName === ERROR_PROMPT]);

  console.log("\n--- assertions ---");
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }

  for (const service of ["smoke-stream", "smoke-error"]) {
    await spansCol().deleteMany({ service });
    await tracesCol().deleteMany({ service });
  }
  await promptsCol().deleteMany({ name: { $in: [STREAM_PROMPT, ERROR_PROMPT] } });
  await promptVersionsCol().deleteMany({ promptName: { $in: [STREAM_PROMPT, ERROR_PROMPT] } });

  await uberprompt.shutdown();
  await closeDb();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
