import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../app.js';
import { User } from '../models/User.js';
import { Document } from '../models/Document.js';
import { Comment } from '../models/Comment.js';

process.env['JWT_SECRET'] = 'test-secret';

const STUDENT_PLAINTEXT = 'password123';
const TEACHER_PLAINTEXT = 'password456';

const STUDENT_BASE = {
  name: 'Alice',
  email: 'alice@example.com',
  teacher: false,
  screen_name: 'alice123',
};

const TEACHER_BASE = {
  name: 'Bob',
  email: 'bob@example.com',
  teacher: true,
  screen_name: 'bob456',
};

const ANOTHER_STUDENT_BASE = {
  name: 'Charlie',
  email: 'charlie@example.com',
  teacher: false,
  screen_name: 'charlie789',
};

let mongod: MongoMemoryServer;
let studentToken: string;
let teacherToken: string;
let anotherStudentToken: string;
let studentId: string;
let teacherId: string;
let anotherStudentId: string;
let documentId: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Create student user
  const studentRes = await request(app)
    .post('/users')
    .send({ ...STUDENT_BASE, password: STUDENT_PLAINTEXT });
  studentId = studentRes.body._id;

  // Create teacher user
  const teacherRes = await request(app)
    .post('/users')
    .send({ ...TEACHER_BASE, password: TEACHER_PLAINTEXT });
  teacherId = teacherRes.body._id;

  // Create another student user
  const anotherStudentRes = await request(app)
    .post('/users')
    .send({ ...ANOTHER_STUDENT_BASE, password: STUDENT_PLAINTEXT });
  anotherStudentId = anotherStudentRes.body._id;

  // Get tokens for each user
  const studentLoginRes = await request(app)
    .post('/users/login')
    .send({ email: STUDENT_BASE.email, password: STUDENT_PLAINTEXT });
  studentToken = studentLoginRes.body.token;

  const teacherLoginRes = await request(app)
    .post('/users/login')
    .send({ email: TEACHER_BASE.email, password: TEACHER_PLAINTEXT });
  teacherToken = teacherLoginRes.body.token;

  const anotherStudentLoginRes = await request(app)
    .post('/users/login')
    .send({ email: ANOTHER_STUDENT_BASE.email, password: STUDENT_PLAINTEXT });
  anotherStudentToken = anotherStudentLoginRes.body.token;

  // Create a document owned by the student
  const doc = new Document({
    userId: studentId,
    filename: 'test.docx',
    data: Buffer.from('test data'),
    uploadedAt: new Date(),
  });
  const savedDoc = await doc.save();
  documentId = savedDoc._id.toString();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  // Clear comments collection after each test
  await Comment.deleteMany({});
});

describe('POST /comments', () => {
  it('creates a new comment and returns it', async () => {
    const res = await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        documentId,
        text: 'This is a test comment',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      documentId,
      userId: studentId,
      text: 'This is a test comment',
    });
    expect(res.body._id).toBeDefined();
    expect(res.body.createdAt).toBeDefined();
  });

  it('returns 400 when documentId is missing', async () => {
    const res = await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ text: 'This is a test comment' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 when text is missing', async () => {
    const res = await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ documentId });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).post('/comments').send({
      documentId,
      text: 'This is a test comment',
    });

    expect(res.status).toBe(401);
  });

  it('associates the comment with the authenticated user', async () => {
    const res = await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        documentId,
        text: 'Teacher comment',
      });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(teacherId);
  });
});

describe('GET /comments/:documentId', () => {
  it('returns all comments for a document sorted by creation date (newest first)', async () => {
    // Create first comment
    await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ documentId, text: 'First comment' });

    // Add a small delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Create second comment
    await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ documentId, text: 'Second comment' });

    const res = await request(app)
      .get(`/comments/${documentId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    // Most recent should be first
    expect(res.body[0].text).toBe('Second comment');
    expect(res.body[1].text).toBe('First comment');
  });

  it('returns an empty array when no comments exist for a document', async () => {
    const res = await request(app)
      .get(`/comments/${documentId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get(`/comments/${documentId}`);

    expect(res.status).toBe(401);
  });

  it('returns comments with all expected fields', async () => {
    await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ documentId, text: 'Test comment' });

    const res = await request(app)
      .get(`/comments/${documentId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      _id: expect.any(String),
      documentId,
      userId: expect.any(String),
      text: 'Test comment',
      createdAt: expect.any(String),
    });
  });
});

describe('DELETE /comments/:commentId', () => {
  it('deletes a comment when requested by the document owner', async () => {
    // Create a comment by a student
    const createRes = await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${anotherStudentToken}`)
      .send({ documentId, text: 'Comment to delete' });
    const commentId = createRes.body._id;

    // Delete it as the document owner
    const deleteRes = await request(app)
      .delete(`/comments/${commentId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toHaveProperty('message');

    // Verify the comment is deleted
    const getRes = await request(app)
      .get(`/comments/${documentId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(getRes.body).toHaveLength(0);
  });

  it('returns 401 when trying to delete as a non-document owner', async () => {
    // Create a comment on document owned by studentId
    const createRes = await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ documentId, text: 'Comment' });
    const commentId = createRes.body._id;

    // Try to delete it as anotherStudent (not the document owner)
    const deleteRes = await request(app)
      .delete(`/comments/${commentId}`)
      .set('Authorization', `Bearer ${anotherStudentToken}`);

    expect(deleteRes.status).toBe(401);
    expect(deleteRes.body).toHaveProperty('error');
  });

  it('returns 403 when trying to delete a comment written by a teacher', async () => {
    // Create a comment by a teacher
    const createRes = await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ documentId, text: 'Teacher comment' });
    const commentId = createRes.body._id;

    // Try to delete it as the document owner
    const deleteRes = await request(app)
      .delete(`/comments/${commentId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(deleteRes.status).toBe(403);
    expect(deleteRes.body.error).toBe('Cannot delete comments written by teachers');

    // Verify the comment still exists
    const getRes = await request(app)
      .get(`/comments/${documentId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(getRes.body).toHaveLength(1);
  });

  it('returns 404 when the comment does not exist', async () => {
    const nonExistentCommentId = new mongoose.Types.ObjectId();
    const deleteRes = await request(app)
      .delete(`/comments/${nonExistentCommentId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(deleteRes.status).toBe(404);
    expect(deleteRes.body).toHaveProperty('error');
  });

  it('returns 401 when not authenticated', async () => {
    // Create a comment
    const createRes = await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ documentId, text: 'Comment' });
    const commentId = createRes.body._id;

    // Try to delete without authentication
    const deleteRes = await request(app).delete(`/comments/${commentId}`);

    expect(deleteRes.status).toBe(401);
  });

  it('prevents teacher from being a target for deletion even if document owner tries', async () => {
    // Create a comment by a teacher
    const createRes = await request(app)
      .post('/comments')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ documentId, text: 'Protected teacher comment' });
    const commentId = createRes.body._id;

    // Try multiple times to ensure protection
    for (let i = 0; i < 3; i++) {
      const deleteRes = await request(app)
        .delete(`/comments/${commentId}`)
        .set('Authorization', `Bearer ${studentToken}`);

      expect(deleteRes.status).toBe(403);
    }
  });
});
