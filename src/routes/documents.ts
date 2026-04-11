import { spawn } from 'child_process';
import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { Schema, model } from 'mongoose';
import { STRIPPER_IMAGE } from '../container.js';

const CONTAINER_RUNTIME = process.env['CONTAINER_RUNTIME'] ?? 'runsc';

export function stripDocxMetadata(docxBase64: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'podman',
      [
        'run',
        '--rm',
        '-i',
        '--runtime=' + CONTAINER_RUNTIME,
        // Never pull from a registry — only use locally built images
        '--pull=never',
        // Drop every capability
        '--cap-drop=all',
        // Block setuid/setgid-based privilege escalation
        '--security-opt=no-new-privileges',
        // No network access required
        '--network=none',
        // Immutable root filesystem; /tmp is the only writable surface
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=256m',
        // Bound resource usage
        '--pids-limit=100',
        '--memory=512m',
        STRIPPER_IMAGE,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    proc.on('error', reject);

    proc.on('close', (code) => {
      if (code === 137) {
        return reject(
          new Error('Mystic Eyes was killed (SIGKILL), was a zip bomb uploaded? Check logs!!')
        );
      }
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        return reject(new Error(`Mystic Eyes exited with code ${code}: ${stderr}`));
      }
      resolve(Buffer.concat(chunks));
    });

    proc.stdin.write(docxBase64);
    proc.stdin.end();
  });
}

const documentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  filename: String,
  data: Buffer,
  uploadedAt: Date,
  processedAt: Date,
});
const Document = model('Document', documentSchema);

const commentSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const Comment = model('Comment', commentSchema);

const stripJobSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'done', 'failed'], default: 'pending' },
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});
const StripJob = model('StripJob', stripJobSchema);

async function processStripJob(
  jobId: string,
  userId: string,
  filename: string,
  data: string,
  uploadedAt: Date
): Promise<void> {
  try {
    const strippedData = await stripDocxMetadata(Buffer.from(data, 'base64'));
    const document = new Document({
      userId,
      filename,
      data: strippedData,
      uploadedAt,
      processedAt: new Date(),
    });
    await document.save();
    await StripJob.findByIdAndUpdate(jobId, { status: 'done', documentId: document._id });
    console.log(
      'User ',
      userId,
      ' completed strip job:',
      jobId,
      '-> document:',
      document._id,
      ' filename:',
      filename,
      ' uploadedAt:',
      uploadedAt,
      ' processedAt:',
      document.processedAt
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Error processing strip job:', err);
    await StripJob.findByIdAndUpdate(jobId, { status: 'failed', error: message });
  }
}

const router = Router();

/**
 * @swagger
 * /:
 *   post:
 *     summary: Upload a document
 *     description: Upload a new document associated with the authenticated user
 *     tags:
 *       - Documents
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - filename
 *               - data
 *             properties:
 *               filename:
 *                 type: string
 *                 description: Name of the document file
 *               data:
 *                 type: string
 *                 format: byte
 *                 description: Base64-encoded file data
 *     responses:
 *       202:
 *         description: Strip job accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId:
 *                   type: string
 *       400:
 *         description: Missing filename or data in request body
 *       401:
 *         description: Unauthorized - Invalid or missing token
 */
router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.userId;
  const { filename, data } = req.body;
  if (!filename || !data) {
    return res.status(400).json({ error: 'Missing filename or data' });
  }

  const uploadedAt = new Date();
  const job = await new StripJob({ userId }).save();
  console.log('User ', userId, ' created strip job:', job._id);
  processStripJob(String(job._id), String(userId), filename, data, uploadedAt);
  return res.status(202).json({ jobId: job._id });
});

/**
 * @swagger
 * /strip/{jobId}:
 *   get:
 *     summary: Poll a strip job
 *     description: Returns the status of a metadata-strip job. When done, includes the documentId.
 *     tags:
 *       - Documents
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [pending, done, failed]
 *                 documentId:
 *                   type: string
 *                 error:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Job not found
 */
router.get('/strip/:jobId', authMiddleware, async (req: AuthRequest, res) => {
  const job = await StripJob.findById(req.params['jobId']);
  if (!job || String(job.userId) !== String(req.userId)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json({
    status: job.status,
    documentId: job.documentId ?? undefined,
    error: job.error ?? undefined,
  });
});

export default router;
