import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
const COOKIE_NAME = 'bb_token';
export async function hashPassword(plain) {
    return bcrypt.hash(plain, 10);
}
export async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}
export function signToken(user) {
    return jwt.sign(user, env.jwtSecret, { expiresIn: '7d' });
}
const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
export function setAuthCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        // Cross-origin Vercel deployments (different subdomains) require SameSite=None + Secure.
        sameSite: isProd ? 'none' : 'lax',
        secure: isProd,
        maxAge: 7 * 24 * 60 * 60 * 1000,
    });
}
export function clearAuthCookie(res) {
    res.clearCookie(COOKIE_NAME);
}
export async function requireAuth(req, res, next) {
    try {
        const token = req.cookies?.[COOKIE_NAME];
        if (!token) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }
        const payload = jwt.verify(token, env.jwtSecret);
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
                setAuthCookie(res, signToken({
                    id: payload.id,
                    email: payload.email,
                    name: payload.name,
                    workspaceId: membership.workspaceId,
                }));
            }
        }
        next();
    }
    catch {
        res.status(401).json({ error: 'Invalid or expired session' });
    }
}
//# sourceMappingURL=auth.js.map