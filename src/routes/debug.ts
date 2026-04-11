import { Router } from 'express';
import type { Request, Response } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';

const router = Router();
/**
 * @swagger
 * /debug:
 *   get:
 *     summary: Get debug information about the authenticated user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Debug information about the authenticated user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                   example: 1
 *                 userEmail:
 *                   type: string
 *                   example: alice@example.com
 *                 teacher:
 *                   type: boolean
 *                   example: false
 *       401:
 *         description: Unauthorized - no valid token provided
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: No token provided
 *       500:
 *         description: Failed to fetch debug information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to fetch debug information
 */

router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  res.json({
    userId: req.userId,
    userEmail: req.userEmail,
    teacher: req.teacher,
  });
});

export default router;
