import { Router } from 'express';
import type { Request, Response } from 'express';
import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import jwt from 'jsonwebtoken';
import { authMiddleware, type AuthRequest, type JwtPayload } from '../middleware/auth.js';

const userSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  teacher: { type: Boolean, required: true },
  screen_name: { type: String, required: true },
});

type UserHydrated = HydratedDocument<InferSchemaType<typeof userSchema>>;

interface UserPublic {
  _id: string;
  teacher: boolean;
  screen_name: string;
}

function toPublicUser(user: UserHydrated): UserPublic {
  return {
    _id: user._id.toString(),
    teacher: user.teacher,
    screen_name: user.screen_name,
  };
}

const User = model('User', userSchema);

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
router.get('/', authMiddleware, (req: AuthRequest, res: Response) => {
  User.find()
    .then((users) => res.json(users.map(toPublicUser)))
    .catch((err) => res.status(500).json({ error: 'Failed to fetch users' }));
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
  const newUser = new User({ name, email, password, teacher, screen_name });
  if (!name || !email || !password || teacher === undefined || !screen_name) {
    return res
      .status(400)
      .json({ error: 'Missing name, email, password, teacher, or screen_name' });
  }
  console.log(
    'Creating new user:',
    { name, email, teacher, screen_name },
    'at time',
    new Date().toISOString()
  );
  newUser
    .save()
    .then((user) => res.status(201).json(user))
    .catch((err) => res.status(500).json({ error: 'Failed to create user' }));
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
  User.findOne({ email, password })
    .then((user) => {
      if (!user) {
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
    .catch((err) => res.status(500).json({ error: 'Failed to login' }));
});

export default router;
