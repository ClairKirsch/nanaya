import { Schema, model } from 'mongoose';

const totpDeviceSchema = new Schema({
  secret: { type: String, required: true },
  verified: { type: Boolean, default: false },
  name: { type: String },
  createdAt: { type: Date, default: Date.now },
});

export const userSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  teacher: { type: Boolean, required: true },
  screen_name: { type: String, required: true },
  twoFactorDevices: { type: [totpDeviceSchema], default: [] },
});

export const User = model('User', userSchema);
