import Anthropic from "@anthropic-ai/sdk";
import { closeDb, tracedCall } from "@uberprompt/sdk";
import { candidates, type Candidate } from "./candidates";
import { requireEnv } from "./env";

const MODEL = "claude-haiku-4-5";

const negativeReplies = [
  "This feels pushy. A 48-hour ultimatum on a cold email is a red flag — I'm not interested.",
  "Please don't pressure me with 'closing very soon' tactics. This feels pushy and salesy, so I'll pass.",
  "The artificial urgency here feels pushy. I don't respond well to deadline pressure from recruiters I've never spoken to.",
];

const secondaryPrompts = ["follow_up", "reply_handler", "screening_questions", "rejection_note"];

interface ClaudeResult {
  text: string;
  model: string;
  tokens: { input: number; output: number };
}

async function callClaude(client: Anthropic, systemPrompt: string, candidate: Candidate): Promise<ClaudeResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: "user", content: `Candidate profile:\n${JSON.stringify(candidate, null, 2)}` }],
  });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return {
    text,
    model: response.model,
    tokens: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

async function main(): Promise<void> {
  requireEnv("MONGODB_URI", "ANTHROPIC_API_KEY");
  const client = new Anthropic();
  const n = Number(process.argv[2] ?? candidates.length);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`Invalid batch size: ${process.argv[2]}`);
    process.exit(1);
  }

  for (let i = 0; i < n; i++) {
    const candidate = candidates[i % candidates.length];
    if (!candidate) throw new Error("empty candidate pool");
    const seededFailure = i % 3 === 0;
    const reply = negativeReplies[i % negativeReplies.length] ?? negativeReplies[0]!;

    await tracedCall({
      promptName: "first_outreach",
      model: MODEL,
      score: seededFailure ? 0.2 : 0.9,
      input: seededFailure
        ? { candidate, outcome: "candidate_declined", candidateReply: reply }
        : { candidate, outcome: "candidate_engaged" },
      fn: async (rendered) => {
        const r = await callClaude(client, rendered, candidate);
        const output = seededFailure ? `${r.text}\n\n[CANDIDATE REPLIED]: ${reply}` : r.text;
        return { result: output, output, model: r.model, tokens: r.tokens };
      },
    });
    console.log(`trace ${i + 1}/${n} first_outreach ${candidate.name} ${seededFailure ? "FAILED (pushy)" : "ok"}`);

    const secondary = secondaryPrompts[i % secondaryPrompts.length];
    if (!secondary) throw new Error("empty secondary prompt pool");
    await tracedCall({
      promptName: secondary,
      model: MODEL,
      score: 0.8 + (i % 3) * 0.05,
      input:
        secondary === "reply_handler"
          ? { candidate, candidateReply: "Thanks for reaching out — what does the interview process look like?" }
          : { candidate },
      fn: async (rendered) => {
        const r = await callClaude(client, rendered, candidate);
        return { result: r.text, output: r.text, model: r.model, tokens: r.tokens };
      },
    });
    console.log(`trace ${i + 1}/${n} ${secondary} ${candidate.name} ok`);
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
