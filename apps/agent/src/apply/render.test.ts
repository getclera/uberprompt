import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderPromptDoc, type PromptDoc, type PromptFragment } from "@uberprompt/sdk";
import { composeInput, fillInputs, withFragment, withOpenSlots } from "./render";

function makeDoc(fragments: PromptFragment[], template: string): PromptDoc {
  return {
    name: "test-prompt",
    version: 1,
    description: "test",
    fragments,
    template,
    updatedAt: new Date("2026-08-13T00:00:00Z"),
    updatedBy: "test",
  };
}

interface PromptFile {
  name: string;
  template: string;
  fragments: { key: string; text: string }[];
  uses: string[];
}

interface TraceSeed {
  promptName: string;
  input: Record<string, unknown>;
}

async function readRepoJson<T>(relativePath: string): Promise<T> {
  const url = new URL(`../../../demo/${relativePath}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as T;
}

async function loadRefundDoc(): Promise<PromptDoc> {
  const prompt = await readRepoJson<PromptFile>("prompts/refund-agent.json");
  const shared = await Promise.all(
    prompt.uses.map((key) => readRepoJson<{ key: string; text: string }>(`fragments/${key}.json`)),
  );
  const fragments = [
    ...prompt.fragments,
    ...shared.map((f) => ({ key: f.key, text: f.text })),
  ];
  return makeDoc(fragments, prompt.template);
}

test("withFragment replaces only the target fragment", () => {
  const doc = makeDoc(
    [
      { key: "task", text: "old task" },
      { key: "message", text: "" },
    ],
    "{{task}}\n{{message}}",
  );
  const updated = withFragment(doc, "task", "new task");
  assert.equal(updated.fragments.find((f) => f.key === "task")?.text, "new task");
  assert.equal(updated.fragments.find((f) => f.key === "message")?.text, "");
  assert.equal(updated.template, doc.template);
});

test("withFragment does not mutate its input", () => {
  const doc = makeDoc([{ key: "task", text: "original" }], "{{task}}");
  const updated = withFragment(doc, "task", "changed");
  assert.equal(doc.fragments[0]?.text, "original");
  const fragment = updated.fragments[0];
  assert.ok(fragment);
  fragment.text = "mutated after the fact";
  updated.fragments.push({ key: "extra", text: "x" });
  assert.equal(doc.fragments.length, 1);
  assert.equal(doc.fragments[0]?.text, "original");
});

test("withFragment throws on unknown key", () => {
  const doc = makeDoc([{ key: "task", text: "t" }], "{{task}}");
  assert.throws(() => withFragment(doc, "missing", "x"), /missing/);
});

test("fillInputs leaves no placeholders on a real seed trace", async () => {
  const doc = await loadRefundDoc();
  const traces = await readRepoJson<TraceSeed[]>("traces.seed.json");
  const trace = traces.find((t) => t.promptName === "refund-agent");
  assert.ok(trace);
  const filled = fillInputs(renderPromptDoc(withOpenSlots(doc)), trace.input);
  assert.doesNotMatch(filled, /\{\{/);
  assert.ok(filled.includes(String(trace.input.body)));
  assert.ok(filled.includes(`Ticket ${String(trace.input.ticketId)}`));
  assert.ok(filled.includes(`Subject: ${String(trace.input.subject)}`));
});

test("fillInputs prefers a direct key match over the composed content", () => {
  const filled = fillInputs("A:{{message}} B:{{account}}", {
    ticketId: "AC-1",
    subject: "S",
    body: "B-text",
    account: "Pro plan, $49/mo",
  });
  assert.ok(filled.includes("A:Ticket AC-1\nSubject: S\nB-text"));
  assert.ok(filled.includes("B:Pro plan, $49/mo"));
});

test("fillInputs fills content slots with the composed input and others with a marker", () => {
  const filled = fillInputs("{{ticket}}|{{conversation}}|{{environment}}", {
    ticketId: "AC-2",
    body: "help",
  });
  const composed = "Ticket AC-2\nhelp";
  assert.equal(filled, `${composed}|${composed}|(not provided)`);
});

test("composeInput carries transcript and extra fields", () => {
  const composed = composeInput({
    ticketId: "AC-3",
    transcript: "customer asked, agent answered",
    resolved: true,
  });
  assert.equal(composed, "Ticket AC-3\ncustomer asked, agent answered\nresolved: true");
});
