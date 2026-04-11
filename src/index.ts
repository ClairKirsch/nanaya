import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app.js';
import { ensureMetadataStripper } from './container.js';

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tohno';

// Connect to MongoDB, ensure container image, then start server
Promise.all([mongoose.connect(MONGODB_URI), ensureMetadataStripper()])
  .then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
      console.log(`Docs at http://localhost:${PORT}/api-docs`);
    });
  })
  .catch((err) => {
    console.error('Startup error:', err);
    process.exit(1);
  });
console.log('Nanaya loaded!');
