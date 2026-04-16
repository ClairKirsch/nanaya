import { Schema, model } from 'mongoose';

const documentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  filename: String,
  data: Buffer,
  uploadedAt: Date,
  processedAt: Date,
  vector: [Number],
});

export const Document = model('Document', documentSchema);
