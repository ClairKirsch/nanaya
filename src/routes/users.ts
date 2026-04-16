import { Router } from 'express';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { authMiddleware, type AuthRequest, type JwtPayload } from '../middleware/auth.js';
import { User } from '../models/User.js';

const router = Router();

/**
 * @swagger
 * /users:
 *   get:
 *     summary: Get all users
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: A list of users
 *       401:
 *         description: Unauthorized - no valid token provided
 *       500:
 *         description: Failed to fetch users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to fetch users
 *
 */
router.get('/', authMiddleware, (_req: AuthRequest, res: Response) => {
  User.find({}, { password: 0, email: 0, name: 0 })
    .then((users) => res.json(users))
    .catch(() => res.status(500).json({ error: 'Failed to fetch users' }));
});

/**
 * @swagger
 * /users:
 *   post:
 *     summary: Create a new user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - teacher
 *               - email
 *               - password
 *             properties:
 *               name:
 *                 type: string
 *                 example: Alice
 *               teacher:
 *                 type: boolean
 *                 example: false
 *               email:
 *                 type: string
 *                 example: alice@example.com
 *               password:
 *                 type: string
 *                 example: password123
 *               screen_name:
 *                 type: string
 *                 example: alice123
 *
 *
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: number
 *                 name:
 *                   type: string
 *                 teacher:
 *                   type: boolean
 *                 email:
 *                   type: string
 *                 screen_name:
 *                   type: string
 *       400:
 *         description: Missing name, email, password, teacher, or screen_name
 *       500:
 *         description: Failed to create user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to create user
 *
 */
router.post('/', (req: Request, res: Response) => {
  const { name, email, password, teacher, screen_name } = req.body;
  console.log(
    'Received request to create new user:',
    { name, email, teacher, screen_name },
    'at time',
    new Date().toISOString()
  );
  if (!name || !email || !password || teacher === undefined || !screen_name) {
    return res
      .status(400)
      .json({ error: 'Missing name, email, password, teacher, or screen_name' });
  }
  argon2
    .hash(password)
    .then((hashedPassword) => {
      const newUser = new User({ name, email, password: hashedPassword, teacher, screen_name });
      console.log(
        'Creating new user:',
        { name, email, teacher, screen_name },
        'at time',
        new Date().toISOString()
      );
      return newUser.save();
    })
    .then((user) => res.status(201).json(user))
    .catch(() => res.status(500).json({ error: 'Failed to create user' }));
});

/**
 * @swagger
 * /users/login:
 *   post:
 *     summary: Login user and get JWT token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 example: alice@example.com
 *               password:
 *                 type: string
 *                 example: password123
 *     responses:
 *       200:
 *         description: Login successful, returns JWT token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *       400:
 *         description: Missing email or password
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Missing email or password
 *       401:
 *         description: Invalid email or password
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Invalid email or password
 *       500:
 *         description: Failed to login
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Failed to login
 */
router.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }
  User.findOne({ email })
    .then(async (user) => {
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const valid = await argon2.verify(user.password, password);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      const payload: JwtPayload = {
        id: user._id.toString(),
        email: user.email,
        teacher: user.teacher,
      };
      const token = jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: '20d' });
      console.log(
        'Authenticated user:',
        { id: payload.id, email: payload.email, teacher: payload.teacher },
        'at time',
        new Date().toISOString()
      );
      res.json({ token });
    })
    .catch(() => res.status(500).json({ error: 'Failed to login' }));
});

export default router;
