import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import type { Response } from 'superagent';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import app from '../app.js';

process.env['JWT_SECRET'] = 'test-secret';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const { spawn } = await import('child_process');
const spawnMock = vi.mocked(spawn);

function makeMockProc(output: Buffer, exitCode: number, delayMs = 0): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new PassThrough();
  const emitter = new EventEmitter();

  stdin.on('finish', () => {
    setTimeout(() => {
      if (exitCode === 0) {
        stdout.emit('data', output);
      } else {
        stderr.emit('data', Buffer.from('strip failed'));
      }
      emitter.emit('close', exitCode);
    }, delayMs);
  });

  return Object.assign(emitter, { stdout, stderr, stdin }) as unknown as ChildProcess;
}

const ALICE_PLAINTEXT = 'password123';
const BOB_PLAINTEXT = 'password456';

const ALICE_BASE = {
  name: 'Alice',
  email: 'alice@example.com',
  teacher: false,
  screen_name: 'alice123',
};

const DUMMY_DOCX = Buffer.from('PK\x03\x04dummy docx content').toString('base64');
const STRIPPED_DOCX = Buffer.from('PK\x03\x04stripped docx content');

let mongod: MongoMemoryServer;
let token: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await request(app)
    .post('/users')
    .send({ ...ALICE_BASE, password: ALICE_PLAINTEXT });
  const loginRes = await request(app)
    .post('/users/login')
    .send({ email: ALICE_BASE.email, password: ALICE_PLAINTEXT });
  token = loginRes.body.token;
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key]?.deleteMany({});
  }
  spawnMock.mockReset();
});

describe('POST /documents', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post('/documents')
      .send({ filename: 'test.docx', data: DUMMY_DOCX });
    expect(res.status).toBe(401);
  });

  it('returns 400 when filename is missing', async () => {
    const res = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ data: DUMMY_DOCX });
    expect(res.status).toBe(400);
  });

  it('returns 400 when data is missing', async () => {
    const res = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'test.docx' });
    expect(res.status).toBe(400);
  });

  it('returns 202 with a jobId', async () => {
    spawnMock.mockReturnValue(makeMockProc(STRIPPED_DOCX, 0));

    const res = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'test.docx', data: DUMMY_DOCX });

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('jobId');
    expect(typeof res.body.jobId).toBe('string');
  });
});

describe('GET /documents/strip/:jobId', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/documents/strip/000000000000000000000000');
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent jobId', async () => {
    const res = await request(app)
      .get('/documents/strip/000000000000000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('reports pending status immediately after submission', async () => {
    // Process never closes, keeping the job in pending state
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: new PassThrough(),
    }) as unknown as ChildProcess;
    spawnMock.mockReturnValue(proc);

    const postRes = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'test.docx', data: DUMMY_DOCX });

    const { jobId } = postRes.body as { jobId: string };

    const pollRes = await request(app)
      .get(`/documents/strip/${jobId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(pollRes.status).toBe(200);
    expect(pollRes.body.status).toBe('pending');
  });

  it('reports pending then done status with documentId after successful processing', async () => {
    spawnMock.mockReturnValue(makeMockProc(STRIPPED_DOCX, 0, 300));

    const postRes = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'test.docx', data: DUMMY_DOCX });

    const { jobId } = postRes.body as { jobId: string };

    const pendingRes = await request(app)
      .get(`/documents/strip/${jobId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(pendingRes.body.status).toBe('pending');

    let pollRes!: Response;
    await vi.waitFor(
      async () => {
        pollRes = await request(app)
          .get(`/documents/strip/${jobId}`)
          .set('Authorization', `Bearer ${token}`);
        expect(pollRes.body.status).toBe('done');
      },
      { timeout: 5000, interval: 50 }
    );

    expect(pollRes.body).toHaveProperty('documentId');
    expect(typeof pollRes.body.documentId).toBe('string');
    expect(pollRes.body.error).toBeUndefined();
  });

  it('reports failed status with an error message after processing failure', async () => {
    spawnMock.mockReturnValue(makeMockProc(Buffer.alloc(0), 1));

    const postRes = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'test.docx', data: DUMMY_DOCX });

    const { jobId } = postRes.body as { jobId: string };

    let pollRes!: Response;
    await vi.waitFor(
      async () => {
        pollRes = await request(app)
          .get(`/documents/strip/${jobId}`)
          .set('Authorization', `Bearer ${token}`);
        expect(pollRes.body.status).toBe('failed');
      },
      { timeout: 5000, interval: 100 }
    );

    expect(pollRes.body).toHaveProperty('error');
    expect(typeof pollRes.body.error).toBe('string');
    expect(pollRes.body.documentId).toBeUndefined();
  });

  it("returns 404 for another user's job", async () => {
    spawnMock.mockReturnValue(makeMockProc(STRIPPED_DOCX, 0));

    const postRes = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'test.docx', data: DUMMY_DOCX });

    const { jobId } = postRes.body as { jobId: string };

    await request(app).post('/users').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: BOB_PLAINTEXT,
      teacher: false,
      screen_name: 'bob456',
    });
    const bobLogin = await request(app)
      .post('/users/login')
      .send({ email: 'bob@example.com', password: BOB_PLAINTEXT });
    const bobToken: string = bobLogin.body.token;

    const res = await request(app)
      .get(`/documents/strip/${jobId}`)
      .set('Authorization', `Bearer ${bobToken}`);

    expect(res.status).toBe(404);
  });
});
