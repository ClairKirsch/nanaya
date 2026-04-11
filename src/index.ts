import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import app from './app.js';

const execFileAsync = promisify(execFile);

const STRIPPER_IMAGE = 'localhost/metadata-stripper:latest';
const STRIPPER_CONTEXT = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../docker/metadata-stripper'
);

async function ensureMetadataStripper(): Promise<void> {
  try {
    await execFileAsync('podman', ['image', 'exists', STRIPPER_IMAGE]);
    console.log('metadata-stripper image already exists, skipping build');
  } catch {
    console.log('metadata-stripper image not found, building...');
    await execFileAsync('podman', ['build', '-t', STRIPPER_IMAGE, STRIPPER_CONTEXT]);
    console.log('metadata-stripper image built successfully');
  }
}

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tohno';

// Connect to MongoDB, ensure container image, then start server
Promise.all([mongoose.connect(MONGODB_URI), ensureMetadataStripper()])
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
      console.log(`Docs at http://localhost:${PORT}/api-docs`);
    });
  })
  .catch((err) => {
    console.error('Startup error:', err);
    process.exit(1);
  });
console.log('Nanaya loaded!');
