import { spawn } from 'child_process';
import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { STRIPPER_IMAGE } from '../container.js';
import { Document } from '../models/Document.js';
import { StripJob } from '../models/StripJob.js';
import * as genai from '@google/generative-ai';
import mammoth from 'mammoth';

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

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length === 0 || vecB.length === 0) {
    throw new Error('Vectors must not be empty for cosine similarity');
  }
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must be of the same length for cosine similarity');
  }
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i]!, 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return magnitudeA && magnitudeB ? dotProduct / (magnitudeA * magnitudeB) : 0;
}

export async function embedText(text: string): Promise<number[]> {
  const client = new genai.GoogleGenerativeAI(process.env['GEMINI_API_KEY'] ?? '');
  console.log('Embedding text with Gemini API...');
  const model = await client.getGenerativeModel({
    model: 'gemini-embedding-001',
  });
  const result = await model.embedContent(text);
  if (
    result.embedding.values.length === 0 ||
    !result.embedding.values.every((v) => typeof v === 'number')
  ) {
    throw new Error('Failed to get embedding from Gemini API');
  }
  return result.embedding.values;
}

export async function extractText(wordDocument: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: wordDocument });
  return result.value;
}

async function processStripJob(
  jobId: string,
  userId: string,
  filename: string,
  data: string,
  uploadedAt: Date
): Promise<void> {
  try {
    const strippedData = await stripDocxMetadata(Buffer.from(data, 'base64'));
    const textContent = await extractText(strippedData);
    const vector = await embedText(textContent);
    const document = new Document({
      userId,
      filename,
      data: strippedData,
      uploadedAt,
      vector,
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
 *       403:
 *         description: Forbidden - teachers cannot upload documents
 */
router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  if (req.teacher) {
    return res.status(403).json({ error: 'Teachers cannot upload documents' });
  }
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

/**
 * @swagger
 * /search:
 *   post:
 *     summary: Semantic search over documents
 *     description: Embeds the query string and returns documents ranked by cosine similarity.
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
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *                 description: Natural language search query
 *     responses:
 *       200:
 *         description: Ranked list of matching documents
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       documentId:
 *                         type: string
 *                       filename:
 *                         type: string
 *                       similarity:
 *                         type: number
 *                         format: float
 *                         minimum: -1
 *                         maximum: 1
 *       400:
 *         description: Missing query in request body
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       500:
 *         description: Embedding or search failed
 */
router.post('/search', authMiddleware, async (req: AuthRequest, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Missing query in request body' });
  }
  try {
    const queryVector = await embedText(query);
    const documents = await Document.find(
      {},
      { vector: 1, filename: 1, userId: 1 },
      { limit: 100 }
    ).populate('userId', 'screen_name');
    const results = documents
      .map((doc) => ({
        documentId: doc._id,
        filename: doc.filename,
        author: doc.userId,
        similarity: cosineSimilarity(queryVector, doc.vector),
      }))
      .sort((a, b) => b.similarity - a.similarity);
    return res.json({ results });
  } catch (err) {
    console.error('Error during search:', err);
    return res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * @swagger
 * /random:
 *   get:
 *     summary: Get a random document
 *     description: Returns metadata for a randomly selected document from the entire database.
 *     tags:
 *       - Documents
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The ID of a randomly selected document
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 documentId:
 *                   type: string
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       404:
 *         description: No documents found
 */
router.get('/random', authMiddleware, async (_req: AuthRequest, res) => {
  const randomDoc = await Document.aggregate([{ $sample: { size: 1 } }]);
  if (randomDoc.length === 0) {
    return res.status(404).json({ error: 'No documents found' });
  }
  return res.json({ documentId: randomDoc[0]._id });
});

/**
 * @swagger
 * /:
 *   get:
 *     summary: List all documents
 *     description: Returns metadata for all documents on the platform.
 *     tags:
 *       - Documents
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all documents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   documentId:
 *                     type: string
 *                   filename:
 *                     type: string
 *                   uploadedAt:
 *                     type: string
 *                     format: date-time
 *                   processedAt:
 *                     type: string
 *                     format: date-time
 *       401:
 *         description: Unauthorized - Invalid or missing token
 */
router.get('/', authMiddleware, async (_req: AuthRequest, res) => {
  const documents = await Document.find({}, { data: 0, vector: 0 });
  return res.json(
    documents.map((doc) => ({
      documentId: doc._id,
      filename: doc.filename,
      uploadedAt: doc.uploadedAt,
      processedAt: doc.processedAt,
    }))
  );
});

/**
 * @swagger
 * /my_documents:
 *   get:
 *     summary: List your own documents
 *     description: Returns metadata for all documents uploaded by the authenticated user.
 *     tags:
 *       - Documents
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of your documents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   documentId:
 *                     type: string
 *                   filename:
 *                     type: string
 *                   uploadedAt:
 *                     type: string
 *                     format: date-time
 *                   processedAt:
 *                     type: string
 *                     format: date-time
 *       401:
 *         description: Unauthorized - Invalid or missing token
 */
router.get('/my_documents', authMiddleware, async (req: AuthRequest, res) => {
  const documents = await Document.find({ userId: req.userId }, { data: 0, vector: 0 });
  return res.json(
    documents.map((doc) => ({
      documentId: doc._id,
      filename: doc.filename,
      uploadedAt: doc.uploadedAt,
      processedAt: doc.processedAt,
    }))
  );
});

/**
 * @swagger
 * /by_user/{userId}:
 *   get:
 *     summary: List documents by user
 *     description: Returns metadata for all documents uploaded by a specific user.
 *     tags:
 *       - Documents
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the user whose documents to retrieve
 *     responses:
 *       200:
 *         description: List of documents by the specified user
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   documentId:
 *                     type: string
 *                   filename:
 *                     type: string
 *                   uploadedAt:
 *                     type: string
 *                     format: date-time
 *                   processedAt:
 *                     type: string
 *                     format: date-time
 *       401:
 *         description: Unauthorized - Invalid or missing token
 */
router.get('/by_user/:userId', authMiddleware, async (req: AuthRequest, res) => {
  const documents = await Document.find({ userId: req.params['userId'] }, { data: 0, vector: 0 });
  return res.json(
    documents.map((doc) => ({
      documentId: doc._id,
      filename: doc.filename,
      uploadedAt: doc.uploadedAt,
      processedAt: doc.processedAt,
    }))
  );
});

/**
 * @swagger
 * /{documentId}:
 *   get:
 *     summary: Get a document by ID
 *     description: Returns metadata for a document owned by the authenticated user.
 *     tags:
 *       - Documents
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the document to retrieve
 *     responses:
 *       200:
 *         description: Document metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 documentId:
 *                   type: string
 *                 filename:
 *                   type: string
 *                 uploadedAt:
 *                   type: string
 *                   format: date-time
 *                 processedAt:
 *                   type: string
 *                   format: date-time
 *       425:
 *         description: Too Early - Document is currently being stripped or embedded
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       404:
 *         description: Document not found
 */
router.get('/:documentId', authMiddleware, async (req: AuthRequest, res) => {
  const pendingJob = await StripJob.findOne({
    documentId: req.params['documentId'],
    status: 'pending',
  });
  if (pendingJob) {
    return res.status(425).json({ error: 'Document is still being processed' });
  }
  const document = await Document.findById(req.params['documentId']);
  if (!document) {
    return res.status(404).json({ error: 'Document not found' });
  }
  return res.json({
    documentId: document._id,
    filename: document.filename,
    uploadedAt: document.uploadedAt,
    processedAt: document.processedAt,
  });
});

/**
 * @swagger
 * /{documentId}/download:
 *   get:
 *     summary: Download a document
 *     description: Returns the stripped DOCX file for any document.
 *     tags:
 *       - Documents
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the document to download
 *     responses:
 *       200:
 *         description: The DOCX file
 *         content:
 *           application/vnd.openxmlformats-officedocument.wordprocessingml.document:
 *             schema:
 *               type: string
 *               format: binary
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       404:
 *         description: Document not found
 */
router.get('/:documentId/download', authMiddleware, async (req: AuthRequest, res) => {
  const document = await Document.findById(req.params['documentId']);
  if (!document) {
    return res.status(404).json({ error: 'Document not found' });
  }
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${document.filename}"`);
  return res.send(document.data);
});

/**
 * @swagger
 * /{documentId}:
 *   delete:
 *     summary: Delete a document
 *     description: Permanently deletes a document. Only the owner can delete their own documents.
 *     tags:
 *       - Documents
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the document to delete
 *     responses:
 *       204:
 *         description: Document deleted successfully
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       403:
 *         description: Forbidden - Document belongs to another user
 *       404:
 *         description: Document not found
 */
router.delete('/:documentId', authMiddleware, async (req: AuthRequest, res) => {
  const document = await Document.findById(req.params['documentId']);
  if (!document) {
    return res.status(404).json({ error: 'Document not found' });
  }
  if (String(document.userId) !== String(req.userId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await Document.findByIdAndDelete(req.params['documentId']);
  return res.status(204).send();
});

export default router;
