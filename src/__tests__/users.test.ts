import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../app.js';

process.env['JWT_SECRET'] = 'test-secret';

const PLAINTEXT_PASSWORD = 'password123';

const TEST_USER_BASE = {
  name: 'Alice',
  email: 'alice@example.com',
  teacher: false,
  screen_name: 'alice123',
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

describe('POST /users', () => {
  it('creates a new user and returns it', async () => {
    const res = await request(app)
      .post('/users')
      .send({ ...TEST_USER_BASE, password: PLAINTEXT_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: TEST_USER_BASE.name,
      email: TEST_USER_BASE.email,
      teacher: TEST_USER_BASE.teacher,
      screen_name: TEST_USER_BASE.screen_name,
    });
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/users').send({ name: 'Bob' });
    expect(res.status).toBe(400);
  });
});

describe('POST /users/login', () => {
  it('returns a JWT token for valid credentials', async () => {
    await request(app)
      .post('/users')
      .send({ ...TEST_USER_BASE, password: PLAINTEXT_PASSWORD });

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER_BASE.email, password: PLAINTEXT_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(typeof res.body.token).toBe('string');
  });

  it('returns 401 for wrong password', async () => {
    await request(app)
      .post('/users')
      .send({ ...TEST_USER_BASE, password: PLAINTEXT_PASSWORD });

    const res = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER_BASE.email, password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app).post('/users/login').send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /users', () => {
  it('returns the user list when authenticated', async () => {
    await request(app)
      .post('/users')
      .send({ ...TEST_USER_BASE, password: PLAINTEXT_PASSWORD });
    const loginRes = await request(app)
      .post('/users/login')
      .send({ email: TEST_USER_BASE.email, password: PLAINTEXT_PASSWORD });
    const token: string = loginRes.body.token;

    const res = await request(app).get('/users').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ screen_name: TEST_USER_BASE.screen_name });
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/users');
    expect(res.status).toBe(401);
  });
});
