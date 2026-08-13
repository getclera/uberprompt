import { ObjectId } from "mongodb";
import { closeDb, lessonsCol, loadPrompt, type EvalCase, type LessonDoc } from "@uberprompt/sdk";
import { registerUberprompt } from "@uberprompt/tracing";
import { findCulprit } from "./diagnose";
import { collectCases, runEval } from "./evals";
import { authorCandidate } from "./author";
import { applyLesson } from "./index";
import { targetPrompts } from "./targeting";
import { watch } from "./watch";
import { rubricTotal } from "./types";

function usage(): never {
  console.error("usage: apply <target|diagnose|eval|suggest> <lessonId> [promptName]");
  console.error("       apply watch");
  process.exit(1);
}

function scorecard(cases: EvalCase[]): string {
  const header = "case                          kind    base  cand     Δ  verdict";
  const rows = cases.map((c) => {
    const base = rubricTotal(c.baseline);
    const cand = rubricTotal(c.candidate);
    const delta = cand - base;
    return [
      c.caseId.slice(0, 28).padEnd(28),
      c.kind.padEnd(6),
      String(base).padStart(5),
      String(cand).padStart(5),
      (delta > 0 ? `+${delta}` : String(delta)).padStart(6),
      `  ${c.verdict}`,
    ].join(" ");
  });
  return [header, ...rows].join("\n");
}

async function loadLesson(lessonId: ObjectId): Promise<LessonDoc> {
  const lesson = await lessonsCol().findOne({ _id: lessonId });
  if (!lesson) throw new Error(`Lesson not found: ${lessonId.toHexString()}`);
  return lesson;
}

async function cmdTarget(lessonId: ObjectId): Promise<void> {
  const hits = await targetPrompts(await loadLesson(lessonId));
  console.log(`${hits.length} prompt(s) targeted:`);
  for (const hit of hits) {
    const score = hit.score === undefined ? "" : ` (${hit.score.toFixed(2)})`;
    console.log(`  [${hit.rung}]${score} ${hit.prompt} — ${hit.reason}`);
  }
}

async function cmdDiagnose(lessonId: ObjectId, promptName: string): Promise<void> {
  const lesson = await loadLesson(lessonId);
  const culprit = await findCulprit(lesson, await loadPrompt(promptName));
  console.log(`fragment:   ${culprit.fragment}`);
  console.log(`span:       "${culprit.span}"`);
  console.log(`declared:   ${culprit.sharedWith.length > 0 ? culprit.sharedWith.join(", ") : "(prompt-local)"}`);
  console.log(`traces:     ${culprit.traceIds.length}`);
  console.log(`rationale:  ${culprit.rationale}`);
}

async function cmdEval(lessonId: ObjectId, promptName: string): Promise<void> {
  const lesson = await loadLesson(lessonId);
  const doc = await loadPrompt(promptName);
  const culprit = await findCulprit(lesson, doc);
  const baseline = doc.fragments.find((f) => f.key === culprit.fragment);
  if (!baseline) throw new Error(`Prompt "${promptName}" has no fragment "${culprit.fragment}"`);
  const cases = await collectCases(lesson, promptName);
  console.log(`culprit: ${culprit.fragment} | cases: ${cases.length}`);
  const candidate = await authorCandidate({
    lessonText: lesson.text,
    promptName,
    culprit,
    baselineText: baseline.text,
    siblingFragments: doc.fragments
      .filter((f) => f.key !== culprit.fragment && f.text.length > 0)
      .map((f) => ({ key: f.key, text: f.text })),
    failingExamples: [],
  });
  const report = await runEval({
    doc,
    fragmentKey: culprit.fragment,
    candidateText: candidate.newText,
    lessonText: lesson.text,
    cases,
  });
  console.log(scorecard(report.cases));
  console.log(
    `\n${report.summary.passed ? "PASS" : "FAIL"} — replay ${report.summary.replayWins}W/${report.summary.replayLosses}L, golden regressions ${report.summary.goldenRegressions}, avg ${report.summary.baselineAvg.toFixed(1)} -> ${report.summary.candidateAvg.toFixed(1)}`,
  );
}

async function cmdSuggest(lessonId: ObjectId, promptName?: string): Promise<void> {
  const result = await applyLesson(lessonId, promptName ? { only: promptName } : {});
  console.log(`targets: ${result.targets.map((t) => `${t.prompt}[${t.rung}]`).join(", ")}\n`);
  for (const outcome of result.outcomes) {
    const last = outcome.reports[outcome.reports.length - 1];
    console.log(`=== ${outcome.prompt} — ${outcome.status.toUpperCase()} ===`);
    if (outcome.culprit) {
      console.log(`culprit: ${outcome.culprit.fragment} -> "${outcome.culprit.span}"`);
      console.log(
        `declared: ${outcome.culprit.sharedWith.length > 0 ? outcome.culprit.sharedWith.join(", ") : "(prompt-local)"}`,
      );
    }
    if (last) console.log(scorecard(last.cases));
    console.log(`reason: ${outcome.reason}`);
    if (outcome.proposalId) console.log(`proposal: ${outcome.proposalId.toHexString()}`);
    console.log();
  }
}

async function main(): Promise<void> {
  const [command, lessonArg, promptName] = process.argv.slice(2);
  if (!command) usage();
  if (command === "watch") {
    const stop = await watch();
    process.on("SIGINT", () => {
      void stop().then(() => process.exit(0));
    });
    return;
  }
  if (!lessonArg) usage();
  const lessonId = new ObjectId(lessonArg);
  if (command === "target") await cmdTarget(lessonId);
  else if (command === "suggest") await cmdSuggest(lessonId, promptName);
  else if (command === "diagnose" || command === "eval") {
    if (!promptName) usage();
    if (command === "diagnose") await cmdDiagnose(lessonId, promptName);
    else await cmdEval(lessonId, promptName);
  } else usage();
}

const isWatch = process.argv[2] === "watch";
const tracing = registerUberprompt({ service: "uberprompt-agent" });

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (isWatch) return;
    await tracing.shutdown();
    await closeDb();
  });
