import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

const defaultFrontendUrls = [
  'http://localhost:5173',
  'https://bug-board-frontend.vercel.app',
].join(',');

export const env = {
  port: Number(process.env.PORT ?? 4000),
  // Accept a comma-separated list so both localhost and the Vercel URL work.
  frontendUrls: optional('FRONTEND_URL', defaultFrontendUrls)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: required('JWT_SECRET'),
  databaseUrl: required('DATABASE_URL'),
  r2: {
    accountId: optional('R2_ACCOUNT_ID'),
    accessKeyId: optional('R2_ACCESS_KEY_ID'),
    secretAccessKey: optional('R2_SECRET_ACCESS_KEY'),
    bucket: optional('R2_BUCKET_NAME', 'bugbot'),
    publicBaseUrl: optional('R2_PUBLIC_BASE_URL'),
  },
  gemini: {
    apiKey: optional('GEMINI_API_KEY'),
    model: optional('GEMINI_MODEL', 'gemini-1.5-flash'),
  },
};

export const isR2Configured = Boolean(
  env.r2.accountId && env.r2.accessKeyId && env.r2.secretAccessKey,
);

export const isGeminiConfigured = Boolean(env.gemini.apiKey);
