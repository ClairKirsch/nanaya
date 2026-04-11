import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { Schema, model } from 'mongoose';

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

  const document = new Document({
    userId,
    filename,
    data: Buffer.from(data, 'base64'),
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
