import { Schema, model } from 'mongoose';

const stripJobSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'done', 'failed'], default: 'pending' },
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', default: null },
  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

export const StripJob = model('StripJob', stripJobSchema);
