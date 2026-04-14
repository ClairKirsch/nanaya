import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const commentSchema = new Schema({
  documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const Comment = model('Comment', commentSchema);
export type CommentDocument = HydratedDocument<InferSchemaType<typeof commentSchema>>;
