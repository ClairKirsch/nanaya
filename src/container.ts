import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

export const STRIPPER_IMAGE = 'localhost/mystic-eyes-of-metadata-preception:latest';

async function assertRunscInstalled(): Promise<void> {
  try {
    await execFileAsync('runsc', ['--version']);
  } catch {
    throw new Error('runsc (gVisor) is not installed or not in PATH. Cannot run mystic eyes.');
  }
}

const STRIPPER_CONTEXT = path.resolve(
  fileURLToPath(import.meta.url),
  '../../docker/metadata-stripper'
);

export async function ensureMetadataStripper(): Promise<void> {
  await assertRunscInstalled();
  try {
    await execFileAsync('podman', ['image', 'exists', STRIPPER_IMAGE]);
    console.log('mystic-eyes-of-metadata-preception image already exists, skipping build');
  } catch {
    console.log('mystic-eyes-of-metadata-preception image not found, building...');
    await execFileAsync('podman', ['build', '-t', STRIPPER_IMAGE, STRIPPER_CONTEXT]);
    console.log('mystic-eyes-of-metadata-preception image built successfully');
  }
}
