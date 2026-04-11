import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger.js';
import usersRouter from './routes/users.js';
import debugRouter from './routes/debug.js';
import documentsRouter from './routes/documents.js';

const app = express();

app.use(express.json());

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use('/users', usersRouter);
app.use('/debug', debugRouter);
app.use('/documents', documentsRouter);

export default app;
