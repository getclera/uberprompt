const EMBEDDINGS_URL = process.env.VOYAGE_EMBEDDINGS_URL ?? "https://ai.mongodb.com/v1/embeddings";

export const EMBEDDING_MODEL = process.env.VOYAGE_EMBEDDING_MODEL ?? "voyage-3.5-lite";
export const EMBEDDING_DIMS = 1024;

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");
  const res = await fetch(EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`Embeddings failed (${res.status}) at ${EMBEDDINGS_URL}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
  };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedMany([text]);
  if (!vector) throw new Error(`${EMBEDDING_MODEL} returned no embedding`);
  return vector;
}
