import type { ObjectId } from "mongodb";
import type { EvalCase, EvalRunSummary, Rubric, UndeclaredHit } from "@uberprompt/sdk";

export const RUBRIC_AXES = ["taskFit", "tone", "specificity", "lessonAdherence"] as const;

export const WIN_AXES = ["taskFit", "tone", "specificity"] as const;

export const WIN_THRESHOLD = 2;

export interface GoldenCase {
  id: string;
  input: Record<string, unknown>;
  intent: string;
}

export interface EvalCaseSpec {
  caseId: string;
  kind: "replay" | "golden";
  input: Record<string, unknown>;
  intent: string;
}

export interface JudgeVerdict {
  a: Rubric;
  b: Rubric;
  explanation: string;
}

export interface Candidate {
  newText: string;
  reason: string;
}

export interface Culprit {
  fragment: string;
  span: string;
  traceIds: ObjectId[];
  sharedWith: string[];
  rationale: string;
  undeclared?: UndeclaredHit[];
}

export interface EvalReport {
  cases: EvalCase[];
  summary: EvalRunSummary;
  baselineOutputs: Record<string, string>;
  judgeModel: string;
  genModel: string;
}

export function winTotal(rubric: Rubric): number {
  return WIN_AXES.reduce((sum, axis) => sum + (rubric[axis] ?? 0), 0);
}

export function adherence(rubric: Rubric): number {
  return rubric.lessonAdherence ?? 0;
}

export function verdictFor(delta: number): "win" | "tie" | "loss" {
  if (delta >= WIN_THRESHOLD) return "win";
  if (delta <= -WIN_THRESHOLD) return "loss";
  return "tie";
}
