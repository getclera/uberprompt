const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

export const EMBEDDING_MODEL = "voyage-3.5-lite";
export const EMBEDDING_DIMS = 1024;

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`Voyage embeddings failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data: Array<{ index: number; embedding: number[] }>;
  };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedMany([text]);
  if (!vector) throw new Error("Voyage returned no embedding");
  return vector;
}
