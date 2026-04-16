import { describe, it, expect } from 'vitest';
import { embedText } from '../routes/documents.js';

const haveKey = !!process.env['GEMINI_API_KEY'];

describe.skipIf(!haveKey)('Gemini embedText (integration)', () => {
  it('returns a non-empty array of numbers for a plain string', async () => {
    const vector = await embedText('hello world');
    expect(vector.length).toBeGreaterThan(0);
    expect(vector.every((v) => typeof v === 'number' && isFinite(v))).toBe(true);
  });

  it('returns different vectors for different inputs', async () => {
    const [a, b] = await Promise.all([embedText('cat'), embedText('database schema')]);
    expect(a).not.toEqual(b);
  });

  it('ranks semantically similar words closer than unrelated ones', async () => {
    const [dog, puppy, carburetor] = await Promise.all([
      embedText('dog'),
      embedText('puppy'),
      embedText('carburetor'),
    ]);

    const cosineSimilarity = (a: number[], b: number[]) => {
      const dot = a.reduce((sum, v, i) => sum + v * b[i]!, 0);
      const magA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
      const magB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
      return dot / (magA * magB);
    };

    const similarityDogPuppy = cosineSimilarity(dog, puppy);
    const similarityDogCarburetor = cosineSimilarity(dog, carburetor);

    expect(similarityDogPuppy).toBeGreaterThan(similarityDogCarburetor);
  });
});
