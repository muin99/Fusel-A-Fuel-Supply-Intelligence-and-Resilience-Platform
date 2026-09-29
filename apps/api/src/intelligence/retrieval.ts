import knowledge from './knowledge.json' with { type: 'json' };

const tokens = (s: string): string[] => s.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

export interface Doc {
  id: string;
  source: string;
  line?: number;
  text: string;
}

/**
 * Okapi BM25 index (k1 = 1.2, b = 0.75). Built once; queries are O(query terms × docs).
 * Used for the organizer playbook (static) and for incident memory (rebuilt on demand).
 */
export class Bm25Index<T extends Doc> {
  private readonly terms: Map<string, number>[];
  private readonly lengths: number[];
  private readonly df = new Map<string, number>();
  private readonly avg: number;

  constructor(private readonly docs: T[]) {
    this.terms = docs.map((d) => {
      const tf = new Map<string, number>();
      for (const t of tokens(d.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return tf;
    });
    this.lengths = this.terms.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
    this.avg = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, docs.length);
  }

  search(query: string, limit = 5): (T & { score: number })[] {
    const q = [...new Set(tokens(query))];
    const n = this.docs.length;
    return this.docs
      .map((d, i) => {
        let score = 0;
        for (const t of q) {
          const tf = this.terms[i].get(t);
          if (!tf) continue;
          const df = this.df.get(t) ?? 0;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * this.lengths[i]) / this.avg));
        }
        return { ...d, score };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

const playbook = new Bm25Index(knowledge as Doc[]);

/** BM25 retrieval over the versioned organizer documents (problem statement + integration guide). */
export function retrieve(query: string, limit = 5) {
  return playbook.search(query, limit).map(({ id, source, line, text, score }) => ({ id, source, line, text, score }));
}
