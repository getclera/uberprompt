import { MongoClient, type Db, type Collection } from "mongodb";
import {
  COLLECTIONS,
  type EdgeDoc,
  type LessonDoc,
  type PromptDoc,
  type PromptVersionDoc,
  type ProposalDoc,
  type TraceDoc,
} from "./types";

let client: MongoClient | undefined;

export function getClient(): MongoClient {
  if (!client) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set");
    client = new MongoClient(uri);
  }
  return client;
}

export function getDb(): Db {
  return getClient().db(process.env.MONGODB_DB ?? "uberprompt");
}

export function promptsCol(): Collection<PromptDoc> {
  return getDb().collection<PromptDoc>(COLLECTIONS.prompts);
}

export function promptVersionsCol(): Collection<PromptVersionDoc> {
  return getDb().collection<PromptVersionDoc>(COLLECTIONS.promptVersions);
}

export function edgesCol(): Collection<EdgeDoc> {
  return getDb().collection<EdgeDoc>(COLLECTIONS.edges);
}

export function tracesCol(): Collection<TraceDoc> {
  return getDb().collection<TraceDoc>(COLLECTIONS.traces);
}

export function lessonsCol(): Collection<LessonDoc> {
  return getDb().collection<LessonDoc>(COLLECTIONS.lessons);
}

export function proposalsCol(): Collection<ProposalDoc> {
  return getDb().collection<ProposalDoc>(COLLECTIONS.proposals);
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
  }
}
