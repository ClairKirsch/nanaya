import { spawn } from 'child_process';
import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { Schema, model } from 'mongoose';

const STRIPPER_IMAGE = 'localhost/metadata-stripper:latest';

function stripDocxMetadata(docxBase64: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'podman',
      [
        'run',
        '--rm',
        '-i',
        '--runtime=runsc',
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
          new Error('metadata-stripper was killed (SIGKILL), was a zip bomb uploaded? Check logs!!')
        );
      }
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf8');
        return reject(new Error(`metadata-stripper exited with code ${code}: ${stderr}`));
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
});
const Document = model('Document', documentSchema);

const commentSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const Comment = model('Comment', commentSchema);

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
 *       201:
 *         description: Document uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 documentId:
 *                   type: string
 *       400:
 *         description: Missing filename or data in request body
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Server error while saving document
 */
router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.userId;
  const { filename, data } = req.body;
  if (!filename || !data) {
    return res.status(400).json({ error: 'Missing filename or data' });
  }

  let strippedData: Buffer;
  try {
    strippedData = await stripDocxMetadata(Buffer.from(data, 'base64'));
  } catch (err) {
    console.error('Error stripping metadata:', err);
    return res.status(500).json({ error: 'Failed to strip metadata' });
  }

  const document = new Document({
    userId,
    filename,
    data: strippedData,
    uploadedAt: new Date(),
  });

  try {
    await document.save();
    res.status(201).json({ message: 'Document uploaded successfully', documentId: document._id });
  } catch (err) {
    console.error('Error saving document:', err);
    res.status(500).json({ error: 'Failed to save document' });
  }
});

export default router;
