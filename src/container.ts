import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

export const STRIPPER_IMAGE = 'localhost/metadata-stripper:latest';

const STRIPPER_CONTEXT = path.resolve(
  fileURLToPath(import.meta.url),
  '../../docker/metadata-stripper'
);

export async function ensureMetadataStripper(): Promise<void> {
  try {
    await execFileAsync('podman', ['image', 'exists', STRIPPER_IMAGE]);
    console.log('metadata-stripper image already exists, skipping build');
  } catch {
    console.log('metadata-stripper image not found, building...');
    await execFileAsync('podman', ['build', '-t', STRIPPER_IMAGE, STRIPPER_CONTEXT]);
    console.log('metadata-stripper image built successfully');
  }
}
