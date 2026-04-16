import { Schema, model } from 'mongoose';

export const userSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  teacher: { type: Boolean, required: true },
  screen_name: { type: String, required: true },
});

export const User = model('User', userSchema);
