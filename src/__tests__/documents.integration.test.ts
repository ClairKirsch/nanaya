import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractText } from '../routes/documents.js';

const DOCX_BUFFER = readFileSync(resolve('test_files/metadata_showcase.docx'));

describe('extractText (integration)', () => {
  it('extracts non-empty text from the test docx', async () => {
    const text = await extractText(DOCX_BUFFER);
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
