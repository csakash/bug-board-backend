import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';

const COOKIE_NAME = 'bb_token';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  workspaceId?: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
  workspaceId?: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, env.jwtSecret, { expiresIn: '7d' });
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const payload = jwt.verify(token, env.jwtSecret) as AuthUser;
    req.user = {
      id: payload.id,
      email: payload.email,
      name: payload.name,
      workspaceId: payload.workspaceId,
    };
    req.workspaceId = payload.workspaceId;

    // Legacy cookies may not include workspaceId. Resolve it once, then refresh the token.
    if (!req.workspaceId) {
      const membership = await prisma.workspaceMember.findFirst({
        where: { userId: payload.id },
        orderBy: { createdAt: 'asc' },
      });
      req.workspaceId = membership?.workspaceId;
      req.user.workspaceId = membership?.workspaceId;
      if (membership?.workspaceId) {
        setAuthCookie(
          res,
          signToken({
            id: payload.id,
            email: payload.email,
            name: payload.name,
            workspaceId: membership.workspaceId,
          }),
        );
      }
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
