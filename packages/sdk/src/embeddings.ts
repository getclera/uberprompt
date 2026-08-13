import OpenAI from "openai";

export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
export const EMBEDDING_DIMS = 1024;

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    client = new OpenAI();
  }
  return client;
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMS,
  });
  return response.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedMany([text]);
  if (!vector) throw new Error(`${EMBEDDING_MODEL} returned no embedding`);
  return vector;
}
