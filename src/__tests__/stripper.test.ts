import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import JSZip from 'jszip';
import { stripDocxMetadata } from '../routes/documents.js';
import { ensureMetadataStripper } from '../container.js';

const FIXTURE = new URL('../../test_files/metadata_showcase.docx', import.meta.url);

const hasRunsc = (() => {
  try {
    execFileSync('runsc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// These values are present in the fixture's docProps/core.xml
const KNOWN_AUTHOR = 'Jane Doe';
const KNOWN_LAST_MODIFIED_BY = 'Bob Smith';
const KNOWN_TITLE = 'Metadata Showcase Document';
const KNOWN_SUBJECT = 'OOXML Document Metadata';
const KNOWN_KEYWORDS = 'metadata, docx, OOXML';

describe.skipIf(!hasRunsc)('stripDocxMetadata (container smoke)', () => {
  let resultZip: JSZip;

  beforeAll(async () => {
    await ensureMetadataStripper();
    const input = readFileSync(FIXTURE);
    const stripped = await stripDocxMetadata(input);
    resultZip = await JSZip.loadAsync(stripped);
  }, 300_000); // allow time for first-time image build + libreoffice

  it('output is a valid DOCX (ZIP) containing [Content_Types].xml', () => {
    expect(resultZip.files['[Content_Types].xml']).toBeDefined();
  });

  describe('docProps/core.xml', () => {
    let core: string;

    beforeAll(async () => {
      const raw = await resultZip.file('docProps/core.xml')?.async('string');
      core = raw ?? '';
    });

    it('removes author', () => {
      expect(core).not.toContain(KNOWN_AUTHOR);
    });

    it('removes last-modified-by', () => {
      expect(core).not.toContain(KNOWN_LAST_MODIFIED_BY);
    });

    it('removes title', () => {
      expect(core).not.toContain(KNOWN_TITLE);
    });

    it('removes subject', () => {
      expect(core).not.toContain(KNOWN_SUBJECT);
    });

    it('removes keywords', () => {
      expect(core).not.toContain(KNOWN_KEYWORDS);
    });
  });
});
