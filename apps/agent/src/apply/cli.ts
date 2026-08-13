import { ObjectId } from "mongodb";
import { closeDb, lessonsCol, loadPrompt, type EvalCase } from "@uberprompt/sdk";
import { registerUberprompt } from "@uberprompt/tracing";
import { findCulprit } from "./diagnose";
import { collectCases, runEval } from "./evals";
import { authorCandidate } from "./author";
import { applyLesson } from "./index";
import { rubricTotal } from "./types";

function usage(): never {
  console.error("usage: apply <diagnose|eval|suggest> <lessonId> <promptName>");
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

async function loadLesson(lessonId: ObjectId) {
  const lesson = await lessonsCol().findOne({ _id: lessonId });
  if (!lesson) throw new Error(`Lesson not found: ${lessonId.toHexString()}`);
  return lesson;
}

async function cmdDiagnose(lessonId: ObjectId, promptName: string): Promise<void> {
  const lesson = await loadLesson(lessonId);
  const doc = await loadPrompt(promptName);
  const culprit = await findCulprit(lesson, doc);
  console.log(`fragment:   ${culprit.fragment}`);
  console.log(`span:       "${culprit.span}"`);
  console.log(`sharedWith: ${culprit.sharedWith.length > 0 ? culprit.sharedWith.join(", ") : "(prompt-local)"}`);
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

async function cmdSuggest(lessonId: ObjectId, promptName: string): Promise<void> {
  const { proposal, culprit, reports } = await applyLesson(lessonId, promptName);
  const last = reports[reports.length - 1];
  if (last) console.log(scorecard(last.cases));
  console.log(`\nstatus:   ${proposal.status.toUpperCase()} after ${reports.length} attempt(s)`);
  console.log(`culprit:  ${culprit.fragment} -> "${culprit.span}"`);
  console.log(`shared:   ${culprit.sharedWith.length > 0 ? culprit.sharedWith.join(", ") : "(prompt-local)"}`);
  console.log(`proposal: ${proposal._id?.toHexString() ?? "(unsaved)"}`);
  console.log(`\nOLD:\n${proposal.oldText}\n\nNEW:\n${proposal.newText}`);
}

async function main(): Promise<void> {
  const [command, lessonArg, promptName] = process.argv.slice(2);
  if (!command || !lessonArg || !promptName) usage();
  const lessonId = new ObjectId(lessonArg);
  if (command === "diagnose") await cmdDiagnose(lessonId, promptName);
  else if (command === "eval") await cmdEval(lessonId, promptName);
  else if (command === "suggest") await cmdSuggest(lessonId, promptName);
  else usage();
}

const tracing = registerUberprompt({ service: "uberprompt-agent" });

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await tracing.shutdown();
    await closeDb();
  });
