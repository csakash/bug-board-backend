import crypto from 'node:crypto';
import type { ProjectInvite } from '@prisma/client';
import { prisma } from '../db/client.js';
import { env } from '../config/env.js';
import { sendProjectInvite } from './email.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function buildAcceptUrl(token: string): string {
  // Prefer an explicit public origin (APP_URL). Otherwise, in a deployed env
  // pick the first non-localhost frontend URL so emailed links are reachable;
  // in local dev fall back to the first configured frontend URL.
  const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  const nonLocal = env.frontendUrls.find((u) => !/localhost|127\.0\.0\.1/.test(u));
  const base = (
    env.appUrl ||
    (isProd && nonLocal) ||
    env.frontendUrls[0] ||
    'http://localhost:5173'
  ).replace(/\/$/, '');
  return `${base}/invite/${token}`;
}

export interface InviteOutcome {
  invite: ProjectInvite | null;
  alreadyMember: boolean;
  emailSent: boolean;
}

/**
 * Create (or refresh an existing pending) invite for an email on a project,
 * then send the invite email. Idempotent per (project, email):
 * - if the email already belongs to a member → no-op, alreadyMember: true.
 * - if a pending invite exists → refresh its token + expiry and resend.
 * - otherwise → create a new pending invite.
 *
 * `email` is lower-cased and assumed already format-validated by the caller.
 */
export async function inviteToProject(opts: {
  projectId: string;
  email: string;
  invitedById: string;
  inviterName: string;
  projectName: string;
}): Promise<InviteOutcome> {
  const email = opts.email.trim().toLowerCase();

  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existingUser) {
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: opts.projectId, userId: existingUser.id } },
    });
    if (membership) {
      return { invite: null, alreadyMember: true, emailSent: false };
    }
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const existingPending = await prisma.projectInvite.findFirst({
    where: { projectId: opts.projectId, email, status: 'pending' },
  });

  const invite = existingPending
    ? await prisma.projectInvite.update({
        where: { id: existingPending.id },
        // Refresh token + expiry only; don't overwrite role (avoids silently
        // downgrading a future owner-invite when it's re-sent).
        data: { token, expiresAt, invitedById: opts.invitedById },
      })
    : await prisma.projectInvite.create({
        data: {
          projectId: opts.projectId,
          email,
          token,
          expiresAt,
          invitedById: opts.invitedById,
        },
      });

  const emailSent = await sendProjectInvite({
    to: email,
    projectName: opts.projectName,
    inviterName: opts.inviterName,
    acceptUrl: buildAcceptUrl(token),
  });

  return { invite, alreadyMember: false, emailSent };
}
