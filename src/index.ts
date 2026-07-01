import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { env } from './config/env.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { authRouter } from './routes/auth.js';
import { chatRouter } from './routes/chat.js';
import { invitesRouter } from './routes/invites.js';
import { issuesRouter } from './routes/issues.js';
import { projectsRouter } from './routes/projects.js';
import { uploadsRouter } from './routes/uploads.js';

const app = express();

const allowedOrigins = new Set(env.frontendUrls);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow server-to-server calls (no origin) and all listed front-ends.
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' not allowed`));
      }
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'bugbot-backend' });
});

app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/invites', invitesRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api', issuesRouter);
app.use('/api', chatRouter);

app.use(notFound);
app.use(errorHandler);

// In Vercel serverless the module is imported as a handler — do not bind a port.
if (!process.env.VERCEL) {
  app.listen(env.port, () => {
    console.log(`bugbot-backend listening on http://localhost:${env.port}`);
  });
}

export default app;
