import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import {
  clearAuthCookie,
  hashPassword,
  requireAuth,
  setAuthCookie,
  signToken,
  verifyPassword,
  type AuthedRequest,
} from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';

export const authRouter = Router();

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(6).max(200),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { name, email, password } = registerSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new HttpError(409, 'An account with that email already exists');

    const user = await prisma.user.create({
      data: { name, email, password: await hashPassword(password) },
    });

    // Every new user gets a personal workspace.
    const workspace = await prisma.workspace.create({
      data: {
        name: `${name}'s workspace`,
        members: { create: { userId: user.id, role: 'owner' } },
      },
    });

    const authUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      workspaceId: workspace.id,
    };
    setAuthCookie(res, signToken(authUser));
    res.status(201).json({ user: authUser });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await verifyPassword(password, user.password))) {
      throw new HttpError(401, 'Invalid email or password');
    }
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    const authUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      workspaceId: membership?.workspaceId,
    };
    setAuthCookie(res, signToken(authUser));
    res.json({ user: authUser });
  }),
);

authRouter.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ user: req.user, workspaceId: req.workspaceId });
  }),
);
