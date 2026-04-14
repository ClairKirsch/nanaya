import { Router } from 'express';
import type { Response } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { Comment } from '../models/Comment.js';
import { Document } from '../models/Document.js';

const router = Router();

/**
 * @swagger
 * /comments/{documentId}:
 *   get:
 *     summary: Get all comments for a document
 *     description: Retrieve all comments associated with a specific document, sorted by creation date (newest first)
 *     tags:
 *       - Comments
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the document
 *     responses:
 *       200:
 *         description: A list of comments for the document
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   _id:
 *                     type: string
 *                     description: Comment ID
 *                   documentId:
 *                     type: string
 *                     description: Document ID
 *                   userId:
 *                     type: string
 *                     description: User ID of the comment author
 *                   text:
 *                     type: string
 *                     description: Comment text content
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *                     description: Comment creation timestamp
 *       401:
 *         description: Unauthorized - no valid token provided
 *       500:
 *         description: Failed to fetch comments
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to fetch comments
 */
router.get('/:documentId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { documentId } = req.params;
    const comments = await Comment.find({ documentId }).sort({ createdAt: -1 }).exec();
    res.json(comments);
  } catch {
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

/**
 * @swagger
 * /comments:
 *   post:
 *     summary: Add a comment to a document
 *     description: Create a new comment on a specific document
 *     tags:
 *       - Comments
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - documentId
 *               - text
 *             properties:
 *               documentId:
 *                 type: string
 *                 description: ID of the document to comment on
 *                 example: 507f1f77bcf86cd799439011
 *               text:
 *                 type: string
 *                 description: The comment text
 *                 example: This document needs revision
 *     responses:
 *       201:
 *         description: Comment created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 _id:
 *                   type: string
 *                   description: Comment ID
 *                 documentId:
 *                   type: string
 *                 userId:
 *                   type: string
 *                 text:
 *                   type: string
 *                 createdAt:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing documentId or text
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Missing documentId or text
 *       401:
 *         description: Unauthorized - no valid token provided
 *       500:
 *         description: Failed to create comment
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to create comment
 */
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { documentId, text } = req.body;
    const userId = req.userId;

    if (!documentId || !text) {
      return res.status(400).json({ error: 'Missing documentId or text' });
    }

    const comment = new Comment({
      documentId,
      userId,
      text,
    });
    const savedComment = await comment.save();
    res.status(201).json(savedComment);
  } catch {
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

/**
 * @swagger
 * /comments/{commentId}:
 *   delete:
 *     summary: Delete a comment
 *     description: Delete a comment from a document. Only the document owner can delete comments, but cannot delete comments written by teachers.
 *     tags:
 *       - Comments
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: commentId
 *         required: true
 *         schema:
 *           type: string
 *         description: The ID of the comment to delete
 *     responses:
 *       200:
 *         description: Comment deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Comment deleted successfully
 *       401:
 *         description: Unauthorized - not the document owner
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Unauthorized
 *       403:
 *         description: Forbidden - cannot delete comments written by teachers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Cannot delete comments written by teachers
 *       404:
 *         description: Comment or document not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Comment not found
 *       500:
 *         description: Failed to delete comment
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to delete comment
 */
router.delete('/:commentId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { commentId } = req.params;
    const userId = req.userId;

    const comment = await Comment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const commentAuthor = await User.findById(comment.userId);
    if (!commentAuthor) {
      return res.status(404).json({ error: 'Comment author not found' });
    }

    if (commentAuthor.teacher) {
      return res.status(403).json({ error: 'Cannot delete comments written by teachers' });
    }

    const document = await Document.findById(comment.documentId);
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (String(document.userId) !== String(userId)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await Comment.findByIdAndDelete(commentId);
    console.log(
      'User ',
      userId,
      ' deleted comment:',
      commentId,
      ' on document:',
      comment.documentId
    );
    res.json({ message: 'Comment deleted successfully' });
  } catch {
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

export default router;
