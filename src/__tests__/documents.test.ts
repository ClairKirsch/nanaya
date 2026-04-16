import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import type { Response } from 'superagent';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcess } from 'child_process';
import app from '../app.js';
import { Document } from '../models/Document.js';
import { StripJob } from '../models/StripJob.js';
import { User } from '../models/User.js';

process.env['JWT_SECRET'] = 'test-secret';

const mockEmbedContent = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn() };
});

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockResolvedValue({
        embedContent: mockEmbedContent,
      }),
    };
  }),
}));

vi.mock('mammoth', () => ({
  default: { extractRawText: vi.fn().mockResolvedValue({ value: 'dummy text' }) },
}));

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

beforeEach(() => {
  mockEmbedContent.mockResolvedValue({ embedding: { values: [0.1, 0.2, 0.3] } });
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key]?.deleteMany({});
  }
  spawnMock.mockReset();
  mockEmbedContent.mockReset();
});

describe('POST /documents', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post('/documents')
      .send({ filename: 'test.docx', data: DUMMY_DOCX });
    expect(res.status).toBe(401);
  });

  it('returns 403 when a teacher tries to upload', async () => {
    await request(app).post('/users').send({
      name: 'Teacher',
      email: 'teacher@example.com',
      password: 'teacherpass',
      teacher: true,
      screen_name: 'prof1',
    });
    const loginRes = await request(app)
      .post('/users/login')
      .send({ email: 'teacher@example.com', password: 'teacherpass' });
    const teacherToken: string = loginRes.body.token;

    const res = await request(app)
      .post('/documents')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ filename: 'test.docx', data: DUMMY_DOCX });
    expect(res.status).toBe(403);
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

describe('POST /documents/search', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).post('/documents/search').send({ query: 'hello' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when query is missing', async () => {
    const res = await request(app)
      .post('/documents/search')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns empty results when the user has no documents', async () => {
    mockEmbedContent.mockResolvedValue({ embedding: { values: [1, 0] } });

    const res = await request(app)
      .post('/documents/search')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'anything' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('returns results sorted by cosine similarity descending', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    await Document.insertMany([
      { userId: alice!._id, filename: 'a.docx', vector: [1, 0], uploadedAt: new Date() },
      { userId: alice!._id, filename: 'b.docx', vector: [0, 1], uploadedAt: new Date() },
      { userId: alice!._id, filename: 'c.docx', vector: [1, 1], uploadedAt: new Date() },
    ]);

    // Query vector [1, 0]: similarity to a=1.0, c≈0.707, b=0.0
    mockEmbedContent.mockResolvedValue({ embedding: { values: [1, 0] } });

    const res = await request(app)
      .post('/documents/search')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'find a' });

    expect(res.status).toBe(200);
    const filenames = res.body.results.map((r: { filename: string }) => r.filename);
    expect(filenames).toEqual(['a.docx', 'c.docx', 'b.docx']);
    expect(res.body.results[0].similarity).toBeCloseTo(1.0);
    expect(res.body.results[2].similarity).toBeCloseTo(0.0);
  });

  it('returns documents from all users', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    await request(app).post('/users').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: BOB_PLAINTEXT,
      teacher: false,
      screen_name: 'bob456',
    });
    const bob = await User.findOne({ email: 'bob@example.com' });

    await Document.insertMany([
      { userId: alice!._id, filename: 'alice.docx', vector: [1, 0], uploadedAt: new Date() },
      { userId: bob!._id, filename: 'bob.docx', vector: [1, 0], uploadedAt: new Date() },
    ]);

    mockEmbedContent.mockResolvedValue({ embedding: { values: [1, 0] } });

    const res = await request(app)
      .post('/documents/search')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'test' });

    expect(res.status).toBe(200);
    const filenames = res.body.results.map((r: { filename: string }) => r.filename);
    expect(filenames).toContain('alice.docx');
    expect(filenames).toContain('bob.docx');
  });
});

describe('GET /documents/random', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/documents/random');
    expect(res.status).toBe(401);
  });

  it('returns 404 when there are no documents', async () => {
    const res = await request(app).get('/documents/random').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns a document with the expected fields', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    await Document.create({
      userId: alice!._id,
      filename: 'sample.docx',
      vector: [1, 0],
      uploadedAt: new Date(),
      processedAt: new Date(),
    });

    const res = await request(app).get('/documents/random').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('documentId');
    expect(Object.keys(res.body)).toEqual(['documentId']);
  });

  it('can return documents belonging to any user', async () => {
    await request(app).post('/users').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: BOB_PLAINTEXT,
      teacher: false,
      screen_name: 'bob456',
    });
    const bob = await User.findOne({ email: 'bob@example.com' });
    await Document.create({
      userId: bob!._id,
      filename: 'bobs.docx',
      vector: [0, 1],
      uploadedAt: new Date(),
      processedAt: new Date(),
    });

    const res = await request(app).get('/documents/random').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.documentId).toBe('string');
  });
});

describe('GET /documents', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/documents');
    expect(res.status).toBe(401);
  });

  it('returns an empty array when there are no documents', async () => {
    const res = await request(app).get('/documents').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns documents from all users', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    await request(app).post('/users').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: BOB_PLAINTEXT,
      teacher: false,
      screen_name: 'bob456',
    });
    const bob = await User.findOne({ email: 'bob@example.com' });
    await Document.insertMany([
      {
        userId: alice!._id,
        filename: 'alice.docx',
        vector: [1, 0],
        uploadedAt: new Date(),
        processedAt: new Date(),
      },
      {
        userId: bob!._id,
        filename: 'bob.docx',
        vector: [0, 1],
        uploadedAt: new Date(),
        processedAt: new Date(),
      },
    ]);

    const res = await request(app).get('/documents').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const filenames = res.body.map((d: { filename: string }) => d.filename);
    expect(filenames).toContain('alice.docx');
    expect(filenames).toContain('bob.docx');
  });

  it('returns documents with expected metadata fields and no data or vector', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    await Document.create({
      userId: alice!._id,
      filename: 'test.docx',
      data: Buffer.from('secret'),
      vector: [1, 0],
      uploadedAt: new Date(),
      processedAt: new Date(),
    });

    const res = await request(app).get('/documents').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty('documentId');
    expect(res.body[0]).toHaveProperty('filename');
    expect(res.body[0]).toHaveProperty('uploadedAt');
    expect(res.body[0]).toHaveProperty('processedAt');
    expect(res.body[0]).not.toHaveProperty('data');
    expect(res.body[0]).not.toHaveProperty('vector');
  });
});

describe('GET /documents/my_documents', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/documents/my_documents');
    expect(res.status).toBe(401);
  });

  it('returns an empty array when the user has no documents', async () => {
    const res = await request(app)
      .get('/documents/my_documents')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns only the authenticated user's own documents", async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    await request(app).post('/users').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: BOB_PLAINTEXT,
      teacher: false,
      screen_name: 'bob456',
    });
    const bob = await User.findOne({ email: 'bob@example.com' });
    await Document.insertMany([
      {
        userId: alice!._id,
        filename: 'alice.docx',
        vector: [1, 0],
        uploadedAt: new Date(),
        processedAt: new Date(),
      },
      {
        userId: bob!._id,
        filename: 'bob.docx',
        vector: [0, 1],
        uploadedAt: new Date(),
        processedAt: new Date(),
      },
    ]);

    const res = await request(app)
      .get('/documents/my_documents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].filename).toBe('alice.docx');
  });
});

describe('GET /documents/by_user/:userId', () => {
  it('returns 401 without a token', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    const res = await request(app).get(`/documents/by_user/${alice!._id}`);
    expect(res.status).toBe(401);
  });

  it('returns an empty array for a user with no documents', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    const res = await request(app)
      .get(`/documents/by_user/${alice!._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns only the specified user's documents", async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    await request(app).post('/users').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: BOB_PLAINTEXT,
      teacher: false,
      screen_name: 'bob456',
    });
    const bob = await User.findOne({ email: 'bob@example.com' });
    await Document.insertMany([
      {
        userId: alice!._id,
        filename: 'alice.docx',
        vector: [1, 0],
        uploadedAt: new Date(),
        processedAt: new Date(),
      },
      {
        userId: bob!._id,
        filename: 'bob.docx',
        vector: [0, 1],
        uploadedAt: new Date(),
        processedAt: new Date(),
      },
    ]);

    const res = await request(app)
      .get(`/documents/by_user/${bob!._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].filename).toBe('bob.docx');
  });
});

describe('GET /documents/:documentId', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/documents/000000000000000000000000');
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent document', async () => {
    const res = await request(app)
      .get('/documents/000000000000000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns document metadata with expected fields', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    const doc = await Document.create({
      userId: alice!._id,
      filename: 'meta.docx',
      data: Buffer.from('x'),
      vector: [1, 0],
      uploadedAt: new Date(),
      processedAt: new Date(),
    });

    const res = await request(app)
      .get(`/documents/${doc._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      documentId: doc._id.toString(),
      filename: 'meta.docx',
    });
    expect(res.body).toHaveProperty('uploadedAt');
    expect(res.body).toHaveProperty('processedAt');
    expect(res.body).not.toHaveProperty('data');
    expect(res.body).not.toHaveProperty('vector');
  });

  it("returns another user's document (social site — no ownership check)", async () => {
    await request(app).post('/users').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: BOB_PLAINTEXT,
      teacher: false,
      screen_name: 'bob456',
    });
    const bob = await User.findOne({ email: 'bob@example.com' });
    const doc = await Document.create({
      userId: bob!._id,
      filename: 'bobs.docx',
      vector: [0, 1],
      uploadedAt: new Date(),
      processedAt: new Date(),
    });

    const res = await request(app)
      .get(`/documents/${doc._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('bobs.docx');
  });

  it('returns 425 when a strip job is still pending for the document', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    const doc = await Document.create({
      userId: alice!._id,
      filename: 'processing.docx',
      vector: [],
      uploadedAt: new Date(),
    });
    await StripJob.create({ userId: alice!._id, documentId: doc._id, status: 'pending' });

    const res = await request(app)
      .get(`/documents/${doc._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(425);
  });
});

describe('GET /documents/:documentId/download', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/documents/000000000000000000000000/download');
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent document', async () => {
    const res = await request(app)
      .get('/documents/000000000000000000000000/download')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns the file with the correct content-type and filename', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    const fileData = Buffer.from('PK\x03\x04fake docx bytes');
    const doc = await Document.create({
      userId: alice!._id,
      filename: 'download-me.docx',
      data: fileData,
      vector: [1, 0],
      uploadedAt: new Date(),
      processedAt: new Date(),
    });

    const res = await request(app)
      .get(`/documents/${doc._id}/download`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/wordprocessingml/);
    expect(res.headers['content-disposition']).toContain('download-me.docx');
    expect(Number(res.headers['content-length'])).toBe(fileData.length);
  });

  it("allows downloading another user's document (social site — no ownership check)", async () => {
    await request(app).post('/users').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: BOB_PLAINTEXT,
      teacher: false,
      screen_name: 'bob456',
    });
    const bob = await User.findOne({ email: 'bob@example.com' });
    const doc = await Document.create({
      userId: bob!._id,
      filename: 'bobs.docx',
      data: Buffer.from('data'),
      vector: [0, 1],
      uploadedAt: new Date(),
      processedAt: new Date(),
    });

    const res = await request(app)
      .get(`/documents/${doc._id}/download`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});

describe('DELETE /documents/:documentId', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).delete('/documents/000000000000000000000000');
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent document', async () => {
    const res = await request(app)
      .delete('/documents/000000000000000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 403 when a non-owner tries to delete', async () => {
    await request(app).post('/users').send({
      name: 'Bob',
      email: 'bob@example.com',
      password: BOB_PLAINTEXT,
      teacher: false,
      screen_name: 'bob456',
    });
    const bob = await User.findOne({ email: 'bob@example.com' });
    const doc = await Document.create({
      userId: bob!._id,
      filename: 'bobs.docx',
      vector: [0, 1],
      uploadedAt: new Date(),
    });

    const res = await request(app)
      .delete(`/documents/${doc._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns 204 and removes the document when the owner deletes it', async () => {
    const alice = await User.findOne({ email: ALICE_BASE.email });
    const doc = await Document.create({
      userId: alice!._id,
      filename: 'mine.docx',
      vector: [1, 0],
      uploadedAt: new Date(),
    });

    const deleteRes = await request(app)
      .delete(`/documents/${doc._id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(deleteRes.status).toBe(204);
    expect(await Document.findById(doc._id)).toBeNull();
  });
});
