import cors from 'cors';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger.js';
import usersRouter from './routes/users.js';
import debugRouter from './routes/debug.js';
import documentsRouter from './routes/documents.js';
import commentRouter from './routes/comments.js';

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:4200' }));
app.use(express.json());

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use('/users', usersRouter);
app.use('/debug', debugRouter);
app.use('/documents', documentsRouter);
app.use('/comments', commentRouter);

export default app;
