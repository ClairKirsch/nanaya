import { Router } from 'express';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
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
 *               totp:
 *                 type: string
 *                 description: Current TOTP code. Required if the account has a verified 2FA device enrolled.
 *                 example: "123456"
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
 *         description: Invalid credentials or TOTP token
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   enum:
 *                     - Invalid email or password
 *                     - TOTP token required
 *                     - Invalid TOTP token
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
  const { email, password, totp } = req.body;
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
      const verifiedDevices = user.twoFactorDevices.filter((d) => d.verified);
      if (verifiedDevices.length > 0) {
        if (!totp) {
          return res.status(401).json({ error: 'TOTP token required' });
        }
        const totpValid = verifiedDevices.some(
          (d) => verifySync({ token: totp, secret: d.secret, epochTolerance: 30 }).valid
        );
        if (!totpValid) {
          return res.status(401).json({ error: 'Invalid TOTP token' });
        }
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

/**
 * @swagger
 * /users/totp/setup:
 *   post:
 *     summary: Begin TOTP enrollment
 *     description: Generates a new TOTP secret and returns a provisioning URI and QR code. The device is not active until confirmed via /users/totp/verify.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Human-readable label for the device (e.g. "iPhone"). Defaults to "Authenticator".
 *                 example: iPhone
 *     responses:
 *       200:
 *         description: Secret created. Scan the QR code with an authenticator app, then call /users/totp/verify.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deviceId:
 *                   type: string
 *                   description: ID of the newly created (unverified) device
 *                   example: 6650f3e2c2a4b00012345678
 *                 uri:
 *                   type: string
 *                   description: otpauth:// URI for manual entry into an authenticator app
 *                   example: otpauth://totp/Nanaya:alice@example.com?secret=BASE32SECRET&issuer=Nanaya
 *                 qrCode:
 *                   type: string
 *                   description: Base64-encoded PNG data URL of the QR code
 *                   example: data:image/png;base64,...
 *       401:
 *         description: Unauthorized - no valid token provided
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to set up TOTP
 */
router.post('/totp/setup', authMiddleware, async (req: AuthRequest, res: Response) => {
  console.log('TOTP setup hit, body:', req.body, 'userId:', req.userId);
  const name = req.body?.name;
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const secret = generateSecret();
    user.twoFactorDevices.push({ secret, verified: false, name: name ?? 'Authenticator' });
    await user.save();

    const device = user.twoFactorDevices.find((d) => d.secret === secret);
    if (!device) return res.status(500).json({ error: 'Failed to set up TOTP' });
    const uri = generateURI({ issuer: 'Nanaya', label: user.email, secret });
    const qrCode = await QRCode.toDataURL(uri);

    res.json({ deviceId: device._id, uri, qrCode });
  } catch {
    res.status(500).json({ error: 'Failed to set up TOTP' });
  }
});

/**
 * @swagger
 * /users/totp/verify:
 *   post:
 *     summary: Confirm TOTP enrollment
 *     description: Verifies a TOTP code against any unverified device on the account and marks it as active. Must be called after /users/totp/setup before the device is used at login.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *                 description: 6-digit TOTP code from the authenticator app
 *                 example: "123456"
 *     responses:
 *       200:
 *         description: Device verified and activated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 detail:
 *                   type: string
 *                   example: TOTP verified successfully
 *                 deviceId:
 *                   type: string
 *                   example: 6650f3e2c2a4b00012345678
 *       400:
 *         description: Missing token or code does not match any unverified device
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   enum:
 *                     - Missing token
 *                     - Invalid TOTP token
 *       401:
 *         description: Unauthorized - no valid token provided
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to verify TOTP
 */
router.post('/totp/verify', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const device = user.twoFactorDevices.find(
      (d) => !d.verified && verifySync({ token, secret: d.secret, epochTolerance: 30 }).valid
    );
    if (!device) return res.status(400).json({ error: 'Invalid TOTP token' });

    device.verified = true;
    await user.save();
    res.json({ detail: 'TOTP verified successfully', deviceId: device._id });
  } catch {
    res.status(500).json({ error: 'Failed to verify TOTP' });
  }
});

/**
 * @swagger
 * /users/totp/devices:
 *   get:
 *     summary: List enrolled TOTP devices
 *     description: Returns all TOTP devices on the account. Secrets are never included in the response.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of devices
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   _id:
 *                     type: string
 *                     example: 6650f3e2c2a4b00012345678
 *                   name:
 *                     type: string
 *                     example: iPhone
 *                   verified:
 *                     type: boolean
 *                     example: true
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *       401:
 *         description: Unauthorized - no valid token provided
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to fetch devices
 */
router.get('/totp/devices', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId, { 'twoFactorDevices.secret': 0 });
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json(user.twoFactorDevices);
  } catch {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

/**
 * @swagger
 * /users/totp/{deviceId}:
 *   delete:
 *     summary: Remove a TOTP device
 *     description: Permanently removes a TOTP device from the account. If it was the last verified device, TOTP will no longer be required at login.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the device to remove
 *         example: 6650f3e2c2a4b00012345678
 *     responses:
 *       200:
 *         description: Device removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 detail:
 *                   type: string
 *                   example: Device removed
 *       401:
 *         description: Unauthorized - no valid token provided
 *       404:
 *         description: User or device not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   enum:
 *                     - User not found
 *                     - Device not found
 *       500:
 *         description: Failed to remove device
 */
router.delete('/totp/:deviceId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const device = user.twoFactorDevices.id(req.params.deviceId as string);
    if (!device) return res.status(404).json({ error: 'Device not found' });
    device.deleteOne();

    await user.save();
    res.json({ detail: 'Device removed' });
  } catch {
    res.status(500).json({ error: 'Failed to remove device' });
  }
});

export default router;
