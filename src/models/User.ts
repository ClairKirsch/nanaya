import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const userSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  teacher: { type: Boolean, required: true },
  screen_name: { type: String, required: true },
});

export type UserHydrated = HydratedDocument<InferSchemaType<typeof userSchema>>;

export interface UserPublic {
  _id: string;
  teacher: boolean;
  screen_name: string;
}

export function toPublicUser(user: UserHydrated): UserPublic {
  return {
    _id: user._id.toString(),
    teacher: user.teacher,
    screen_name: user.screen_name,
  };
}

export const User = model('User', userSchema);
