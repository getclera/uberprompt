import type { DefinePromptArgs } from "@uberprompt/sdk";

const tone =
  "Professional, warm, and respectful of the candidate's time. Write like a thoughtful human recruiter, not a mass-mailer. Short sentences, no jargon, no exclamation marks. Keep messages under 120 words.";

const candidateContext =
  "You will receive a candidate profile as JSON with name, current role, company, years of experience, key skills, and location. Reference at most two specific details from the profile so the message feels personal, never like a template blast.";

const companyPitch =
  "The hiring company is Nimbus Labs, a fast-growing talent-intelligence startup. Small senior engineering team, meaningful equity, remote-first across Europe, shipping AI products used by hundreds of recruiting teams.";

export const promptSuite: DefinePromptArgs[] = [
  {
    name: "first_outreach",
    fragments: {
      tone,
      candidate_context: candidateContext,
      company_pitch: companyPitch,
      task: "Write the first cold outreach message to this candidate about the open Senior Engineer role. Hook them with one specific detail from their profile, pitch the company in a single sentence, and close with a clear call to action. Create urgency: state that the role is closing very soon and push the candidate to reply within 48 hours so they do not miss out.",
    },
    template: "{{tone}}\n\n{{candidate_context}}\n\n{{company_pitch}}\n\n{{task}}",
  },
  {
    name: "follow_up",
    fragments: {
      tone,
      candidate_context: candidateContext,
      task: "Write a short follow-up to a candidate who has not replied to the first outreach. Reference the earlier message without guilt-tripping, add one genuinely new piece of information about the role, and make it easy for them to say no.",
    },
    template: "{{tone}}\n\n{{candidate_context}}\n\n{{task}}",
    uses: [
      { prompt: "first_outreach", fragment: "tone" },
      { prompt: "first_outreach", fragment: "candidate_context" },
    ],
  },
  {
    name: "reply_handler",
    fragments: {
      tone,
      candidate_context: candidateContext,
      company_pitch: companyPitch,
      task: "Given the candidate's reply included in the input, draft the recruiter's response. Answer their questions directly, be honest about anything unknown, and propose one concrete next step such as a 20-minute intro call.",
    },
    template: "{{tone}}\n\n{{candidate_context}}\n\n{{company_pitch}}\n\n{{task}}",
    uses: [
      { prompt: "first_outreach", fragment: "tone" },
      { prompt: "first_outreach", fragment: "candidate_context" },
      { prompt: "first_outreach", fragment: "company_pitch" },
    ],
  },
  {
    name: "screening_questions",
    fragments: {
      tone,
      candidate_context: candidateContext,
      task: "Generate exactly 5 screening questions tailored to this candidate's background for a first call. Mix technical depth checks on their key skills with motivation questions. One sentence per question, numbered list.",
    },
    template: "{{tone}}\n\n{{candidate_context}}\n\n{{task}}",
    uses: [
      { prompt: "first_outreach", fragment: "tone" },
      { prompt: "first_outreach", fragment: "candidate_context" },
    ],
  },
  {
    name: "rejection_note",
    fragments: {
      tone,
      company_pitch: companyPitch,
      task: "Write a kind, honest rejection note for this candidate. Thank them for their time, give one genuine positive observation about their background, and leave the door open for future roles. Never use corporate boilerplate.",
    },
    template: "{{tone}}\n\n{{company_pitch}}\n\n{{task}}",
    uses: [
      { prompt: "first_outreach", fragment: "tone" },
      { prompt: "first_outreach", fragment: "company_pitch" },
    ],
  },
];
