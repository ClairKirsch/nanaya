import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { generateSync } from 'otplib';
import app from '../app.js';

process.env['JWT_SECRET'] = 'test-secret';

const PLAINTEXT_PASSWORD = 'password123';

const TEST_USER = {
  name: 'Alice',
  email: 'alice@example.com',
  teacher: false,
  screen_name: 'alice123',
  password: PLAINTEXT_PASSWORD,
};

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key]?.deleteMany({});
  }
});

async function createUserAndLogin(user = TEST_USER): Promise<string> {
  await request(app).post('/users').send(user);
  const res = await request(app)
    .post('/users/login')
    .send({ email: user.email, password: user.password });
  return res.body.token as string;
}

async function setupTotp(
  authToken: string
): Promise<{ deviceId: string; secret: string; setupRes: request.Response }> {
  const setupRes = await request(app)
    .post('/users/totp/setup')
    .set('Authorization', `Bearer ${authToken}`);
  if (setupRes.status !== 200) {
    throw new Error(
      `TOTP setup failed: HTTP ${setupRes.status} — ${JSON.stringify(setupRes.body)}`
    );
  }
  const { deviceId, uri } = setupRes.body;
  const secret = new URL(uri).searchParams.get('secret')!;
  return { deviceId, secret, setupRes };
}

async function getDevices(authToken: string) {
  const res = await request(app)
    .get('/users/totp/devices')
    .set('Authorization', `Bearer ${authToken}`);
  return res.body as { _id: string; name: string; verified: boolean; createdAt: string }[];
}

async function enrollTotp(authToken: string): Promise<{ deviceId: string; secret: string }> {
  const { deviceId, secret } = await setupTotp(authToken);
  const token = generateSync({ secret });
  await request(app)
    .post('/users/totp/verify')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ token });
  return { deviceId, secret };
}

// ─── Setup ──────────────────────────────────────────────────────────────────

describe('POST /users/totp/setup', () => {
  it('returns deviceId, otpauth URI, and base64 QR code', async () => {
    const token = await createUserAndLogin();
    const res = await request(app)
      .post('/users/totp/setup')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('deviceId');
    expect(res.body.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.qrCode).toMatch(/^data:image\/png;base64,/);
  });

  it('embeds the issuer and account name in the URI', async () => {
    const token = await createUserAndLogin();
    const { uri } = (
      await request(app).post('/users/totp/setup').set('Authorization', `Bearer ${token}`)
    ).body;

    expect(uri).toContain('Nanaya');
    expect(uri).toContain(encodeURIComponent(TEST_USER.email));
  });

  it('stores the device name when provided', async () => {
    const token = await createUserAndLogin();
    const res = await request(app)
      .post('/users/totp/setup')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'My iPhone' });

    expect(res.status).toBe(200);
    const devices = await getDevices(token);
    expect(devices).toHaveLength(1);
    expect(devices[0]!.name).toBe('My iPhone');
  });

  it('defaults the device name to "Authenticator" when not provided', async () => {
    const token = await createUserAndLogin();
    await request(app).post('/users/totp/setup').set('Authorization', `Bearer ${token}`);

    const devices = await getDevices(token);
    expect(devices[0]!.name).toBe('Authenticator');
  });

  it('creates the device as unverified', async () => {
    const token = await createUserAndLogin();
    await request(app).post('/users/totp/setup').set('Authorization', `Bearer ${token}`);

    const devices = await getDevices(token);
    expect(devices[0]!.verified).toBe(false);
  });

  it('generates unique secrets for each call', async () => {
    const token = await createUserAndLogin();
    const { secret: secret1 } = await setupTotp(token);
    const { secret: secret2 } = await setupTotp(token);

    expect(secret1).not.toBe(secret2);
  });

  it('returns 401 without a bearer token', async () => {
    const res = await request(app).post('/users/totp/setup');
    expect(res.status).toBe(401);
  });
});

// ─── Verify ─────────────────────────────────────────────────────────────────

describe('POST /users/totp/verify', () => {
  it('activates the device on a valid TOTP code', async () => {
    const authToken = await createUserAndLogin();
    const { secret, deviceId } = await setupTotp(authToken);
    const token = generateSync({ secret });

    const res = await request(app)
      .post('/users/totp/verify')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ token });

    expect(res.status).toBe(200);
    expect(res.body.detail).toBe('TOTP verified successfully');
    expect(res.body.deviceId).toBe(deviceId);

    const devices = await getDevices(authToken);
    expect(devices).toHaveLength(1);
    expect(devices[0]!._id).toBe(deviceId);
    expect(devices[0]!.verified).toBe(true);
  });

  it('returns 400 for an incorrect TOTP code', async () => {
    const authToken = await createUserAndLogin();
    await setupTotp(authToken);

    const res = await request(app)
      .post('/users/totp/verify')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ token: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid TOTP token');

    const devices = await getDevices(authToken);
    expect(devices[0]!.verified).toBe(false);
  });

  it('returns 400 when token field is missing', async () => {
    const authToken = await createUserAndLogin();
    const res = await request(app)
      .post('/users/totp/verify')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing token');
  });

  it('returns 400 when no unverified device exists', async () => {
    const authToken = await createUserAndLogin();

    const res = await request(app)
      .post('/users/totp/verify')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ token: '123456' });

    expect(res.status).toBe(400);
  });

  it('cannot re-verify an already-verified device', async () => {
    const authToken = await createUserAndLogin();
    const { secret } = await setupTotp(authToken);
    const token = generateSync({ secret });

    await request(app)
      .post('/users/totp/verify')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ token });

    // Device is now verified — /verify only checks unverified devices
    const res = await request(app)
      .post('/users/totp/verify')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ token });

    expect(res.status).toBe(400);

    const devices = await getDevices(authToken);
    expect(devices[0]!.verified).toBe(true);
  });

  it('returns 401 without a bearer token', async () => {
    const res = await request(app).post('/users/totp/verify').send({ token: '123456' });
    expect(res.status).toBe(401);
  });
});

// ─── Login ───────────────────────────────────────────────────────────────────

describe('POST /users/login (TOTP enforcement)', () => {
  it('does not require TOTP when no verified devices are enrolled', async () => {
    await request(app).post('/users').send(TEST_USER);

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: PLAINTEXT_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('does not require TOTP if a device is set up but not yet verified', async () => {
    const authToken = await createUserAndLogin();
    await setupTotp(authToken); // not verified

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: PLAINTEXT_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('returns 401 "TOTP token required" when TOTP is enrolled but not provided', async () => {
    const authToken = await createUserAndLogin();
    await enrollTotp(authToken);

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: PLAINTEXT_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOTP token required');
  });

  it('returns 401 "Invalid TOTP token" for a wrong TOTP code', async () => {
    const authToken = await createUserAndLogin();
    await enrollTotp(authToken);

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: PLAINTEXT_PASSWORD, totp: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid TOTP token');
  });

  it('issues a JWT when valid TOTP is provided', async () => {
    const authToken = await createUserAndLogin();
    const { secret } = await enrollTotp(authToken);
    const totp = generateSync({ secret });

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: PLAINTEXT_PASSWORD, totp });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(typeof res.body.token).toBe('string');
  });

  it('rejects a wrong password even when a valid TOTP is provided', async () => {
    const authToken = await createUserAndLogin();
    const { secret } = await enrollTotp(authToken);
    const totp = generateSync({ secret });

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: 'wrongpassword', totp });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('accepts a TOTP from any enrolled verified device', async () => {
    const authToken = await createUserAndLogin();
    const { secret: secret1 } = await enrollTotp(authToken);
    const { secret: secret2 } = await enrollTotp(authToken);

    // Use token from second device
    const totp = generateSync({ secret: secret2 });
    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: PLAINTEXT_PASSWORD, totp });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');

    // Use token from first device
    const totp1 = generateSync({ secret: secret1 });
    const res2 = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: PLAINTEXT_PASSWORD, totp: totp1 });

    expect(res2.status).toBe(200);
  });
});

// ─── Delete ──────────────────────────────────────────────────────────────────

describe('DELETE /users/totp/:deviceId', () => {
  it('removes the device and returns a confirmation', async () => {
    const authToken = await createUserAndLogin();
    const { deviceId } = await enrollTotp(authToken);

    const res = await request(app)
      .delete(`/users/totp/${deviceId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.detail).toBe('Device removed');

    const devices = await getDevices(authToken);
    expect(devices).toHaveLength(0);
  });

  it('returns 404 for an unknown device ID', async () => {
    const authToken = await createUserAndLogin();
    const fakeId = new mongoose.Types.ObjectId().toString();

    const res = await request(app)
      .delete(`/users/totp/${fakeId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Device not found');
  });

  it('returns 401 without a bearer token', async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await request(app).delete(`/users/totp/${fakeId}`);
    expect(res.status).toBe(401);
  });

  it('no longer requires TOTP at login after the last verified device is removed', async () => {
    const authToken = await createUserAndLogin();
    const { deviceId } = await enrollTotp(authToken);

    await request(app)
      .delete(`/users/totp/${deviceId}`)
      .set('Authorization', `Bearer ${authToken}`);

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: PLAINTEXT_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('still enforces TOTP if one device remains after another is deleted', async () => {
    const authToken = await createUserAndLogin();
    const { deviceId: deviceId1 } = await enrollTotp(authToken);
    await enrollTotp(authToken);

    await request(app)
      .delete(`/users/totp/${deviceId1}`)
      .set('Authorization', `Bearer ${authToken}`);

    const devices = await getDevices(authToken);
    expect(devices).toHaveLength(1);

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER.email, password: PLAINTEXT_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('TOTP token required');
  });

  it('cannot delete a device belonging to another user', async () => {
    const aliceToken = await createUserAndLogin();
    const { deviceId } = await enrollTotp(aliceToken);

    const bob = {
      name: 'Bob',
      email: 'bob@example.com',
      teacher: false,
      screen_name: 'bob456',
      password: PLAINTEXT_PASSWORD,
    };
    const bobToken = await createUserAndLogin(bob);

    const res = await request(app)
      .delete(`/users/totp/${deviceId}`)
      .set('Authorization', `Bearer ${bobToken}`);

    expect(res.status).toBe(404);

    const aliceDevices = await getDevices(aliceToken);
    expect(aliceDevices).toHaveLength(1);
    expect(aliceDevices[0]!._id).toBe(deviceId);
  });
});
