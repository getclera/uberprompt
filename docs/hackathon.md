# MongoDB "Persistent Context Sprint" Hackathon 2026 — Context

Reference for anything built in this repo during the event. Source: official participant guide.

## Theme — "No Cold Start"

Build an agent that does **not** start from nothing. MongoDB holds state, memory, and live
application data so the agent returns with what it learned last time.

Hard requirement of the theme: what is stored, retrieved, and checkpointed must **change what the
system does next** — not merely pad the prompt.

Guide's own example directions:
- Agent tracking which retrieval strategies worked (chunk size, reranking, source weights, k) and adapting future runs from outcome scores stored in MongoDB.
- Coding agent keeping repo conventions and past fixes in Atlas, retrieving via vector search, checkpointing through LangGraph so a mid-refactor crash loses no progress.
- Multi-agent system sharing context through MongoDB, discovering capabilities via vector search, coordinating via change streams so handoffs carry state.

## Logistics

- **Location:** Pier 48, San Francisco, CA 94158 — Embarcadero Stage. Enter at Terry A Francois Blvd.
- **ID:** government-issued photo ID required.
- **Build Fest doors:** 8:30 AM PT. **Hackathon check-in:** 1:00 PM PT. Build Fest entry is included; MongoDB emails the QR code — Build Fest access is required to reach the hackathon.
- **Transit:** Mission Rock Muni station (T Third/Central Subway) one block away; 4th & King Caltrain ~15 min walk. Parking scarce — transit or rideshare.
- **Discord:** https://discord.gg/8VUq28JrP2

### Schedule (PT)

| Time | Item |
|---|---|
| 1:00–1:30 PM | Registration, team formation, opening remarks |
| 1:30 PM | Hacking begins |
| **5:00 PM** | **Submissions due** |
| 5:15–6:30 PM | Round one judging (async) |
| 6:30–7:30 PM | Finalists, on-stage demos, live voting |
| 7:30 PM | Winners announced |

Net build time: **3.5 hours.** Scope accordingly.

## Rules

- Repo must be **public**.
- Max 4 team members; solo allowed.
- Demo may only show features/code/functionality built **during** the hackathon. Judges must be able to identify what was built at the event. Failure to distinguish = immediate disqualification.
- No presenting an existing project as new work.
- No code/data/assets without rights; nothing violating legal/ethical/platform policy.

### Disqualified project shapes (explicit anti-list)

Basic RAG apps · Streamlit apps · any project where a **dashboard is the main feature** ·
AI mental-health advisor · "AI for education" chatbot · AI job-application screener ·
AI nutrition coach · personality analyzers · basic image analyzers · sports analyzers/coaches.

(The chatbot/analyzer entries are qualified as "basic, limited technical complexity" — technical
depth is the escape hatch, but do not gamble on it.)

## Judging

Round one — async, on a 1-minute demo video plus public repo link:

| Weight | Criterion |
|---|---|
| **35%** | **Creativity & originality** — unseen concept, differentiation, novel take on the problem statement |
| **25%** | **Technologies used** — effective MongoDB feature use; meaningful partner-tool use (ElevenLabs, LangChain, OpenRouter, Fireworks) core to how it works |
| 20% | Impact potential — usefulness beyond the hackathon |
| 20% | Live demo — implementation quality, works live, presentation |

Round two — top six demo on stage, ~3 min + 1–2 min Q&A, winner by live audience vote, same criteria
at **equal weighting**.

Implication: originality plus deep MongoDB integration outweighs everything else at 60% combined.

## Submission

- Form: https://cerebralvalley.ai/e/persistent-context-sprint-hackathon/submit
- Needs: **1-minute demo video** (only what was built at the event), **public repo link**, all team members added.
- Build **must live in the Atlas Hackathon Sandbox** (link emailed; create project + cluster through it) to be finalist-eligible.

## MongoDB resources

Recommended setup order: install **MongoDB Agent Skills**, connect the **MongoDB MCP Server**, then
use the **Natural Language to MongoDB Queries** prompting guide throughout.

- Data/search: sample movie dataset · data modeling guide · **Vector Search** (semantic, basis of long-term retrievable memory) · **Atlas Search** (typo-tolerant keyword) · **Automated Embeddings** (embeddings generated/maintained in-DB, no separate pipeline) · **Embedding & Reranking API** (one endpoint, any stack).
- Memory/agents: "Building an Agent with Memory and Function Calling" (closest to the theme) · adding memory to a chat app (Python / JavaScript, LangChain + Atlas).
- State: LangGraph + Atlas checkpointing (thread-specific checkpoints, conversation persistence) · "State & Persistence: The Problem of Agent Reliability" (suspend/resume, crash recovery, state vs memory boundary).
- Context: "Build AI Agents with MongoDB" · GraphRAG with MongoDB + LangChain (relationship-aware retrieval).
- Starter code: **GenAI Showcase** (broad example library) · MongoDB + Python quickstart · MERN starter.

## Partner credits

| Partner | Offer | How |
|---|---|---|
| Cursor | Credits | Emailed to Cursor account email; issues → Discord `#cursor` |
| ElevenLabs | 1 month Creator tier (131k credits) | Discord https://discord.com/invite/VnBvbbcdEC → `#coupon-codes` → "Start Redemption" → registration email. Tutorial: https://youtu.be/S143_JtCtV8 |
| Fireworks | $50, code `MONGODB813` (by 10/1) | https://docs.fireworks.ai/ · cookbook https://github.com/fw-ai/cookbook |
| LangChain | $50 + deployments access | Instructions in guide |
| OpenRouter | $10 API credits | Instructions in guide |

## Prizes

- **1st:** $7,500 cash · 1 yr Cursor Ultra · $5,000 Fireworks · $3,000 LangSmith · $1,000 OpenRouter · 3 mo ElevenLabs Pro
- **2nd:** $4,500 cash · $5,000 Fireworks · $2,000 LangSmith · $500 OpenRouter · 3 mo ElevenLabs Pro
- **3rd:** $3,000 cash · $5,000 Fireworks · $1,000 LangSmith · $300 OpenRouter · 3 mo ElevenLabs Pro
- **Best project built with ElevenLabs:** 3 months Scale tier per team member (~$897 value each, 1.8M credits/mo)

### ElevenLabs prize criteria (separate track)

- **Agentic depth** — beyond simple TTS; autonomous agents, complex logic, real-time dialogue.
- **Interaction design** — lifelike; low-latency response, emotional inflection.
- **Technical integration** — creative API use, especially multimodal (voice + video) or clever personality prompt engineering.
- **Novelty** — unseen use case solving a real problem with conversational AI.

## Working constraints for this repo

1. Cluster lives in the Atlas Hackathon Sandbox — no other cluster is eligible.
2. Everything committed here is new work from the event; keep the history clean so judges can read it.
3. MongoDB must be load-bearing (memory/state/coordination), not a logging sink.
4. Persisted context must demonstrably alter later behavior — the demo has to show run N+1 differing from run N.
5. Repo stays public.
