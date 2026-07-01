import { Router } from 'express';
import { prisma } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import { invalidateCache } from '../services/response-cache.js';
import { invalidateProjectCaches } from '../services/project-cache.js';
export const invitesRouter = Router();
// Public: describe an invite so the landing page can render before auth.
// Never requires a session — invite links must work while logged out.
invitesRouter.get('/:token', asyncHandler(async (req, res) => {
    const invite = await prisma.projectInvite.findUnique({
        where: { token: req.params.token },
        include: {
            project: { select: { name: true } },
            invitedBy: { select: { name: true } },
        },
    });
    if (!invite)
        throw new HttpError(404, 'Invite not found');
    const expired = invite.status === 'pending' && invite.expiresAt.getTime() < Date.now();
    res.json({
        invite: {
            projectName: invite.project.name,
            inviterName: invite.invitedBy?.name ?? 'A teammate',
            email: invite.email,
            status: invite.status,
            expired,
        },
    });
}));
// Accept an invite. Requires auth; the caller's email must match the invited
// email (case-insensitive). Idempotent — re-accepting as an existing member is
// a no-op 200.
invitesRouter.post('/:token/accept', requireAuth, asyncHandler(async (req, res) => {
    const invite = await prisma.projectInvite.findUnique({
        where: { token: req.params.token },
    });
    if (!invite)
        throw new HttpError(404, 'Invite not found');
    // Expiry: flip pending → expired on read, then reject.
    if (invite.status === 'pending' && invite.expiresAt.getTime() < Date.now()) {
        await prisma.projectInvite.update({
            where: { id: invite.id },
            data: { status: 'expired' },
        });
        throw new HttpError(410, 'This invite has expired');
    }
    // A row already persisted as expired (e.g. a retry after the flip above)
    // must not fall through to the accept transaction below.
    if (invite.status === 'expired') {
        throw new HttpError(410, 'This invite has expired');
    }
    if (invite.status === 'revoked') {
        throw new HttpError(410, 'This invite has been revoked');
    }
    const callerEmail = req.user.email.trim().toLowerCase();
    if (callerEmail !== invite.email.trim().toLowerCase()) {
        // Email-locked: no silent cross-account accept. Tell the client which
        // email the invite is for so it can prompt a switch.
        res.status(403).json({
            error: 'This invite is for a different email address',
            invitedEmail: invite.email,
        });
        return;
    }
    // Already accepted: only a no-op if the caller is already a member.
    if (invite.status === 'accepted') {
        const existing = await prisma.projectMember.findUnique({
            where: { projectId_userId: { projectId: invite.projectId, userId: req.user.id } },
        });
        if (existing) {
            res.json({ projectId: invite.projectId });
            return;
        }
        // Accepted by a different account previously — treat as consumed.
        throw new HttpError(410, 'This invite has already been used');
    }
    // Upsert membership + mark the invite accepted.
    await prisma.$transaction([
        prisma.projectMember.upsert({
            where: { projectId_userId: { projectId: invite.projectId, userId: req.user.id } },
            create: { projectId: invite.projectId, userId: req.user.id, role: invite.role },
            update: {},
        }),
        prisma.projectInvite.update({
            where: { id: invite.id },
            data: { status: 'accepted', acceptedById: req.user.id },
        }),
    ]);
    await invalidateProjectCaches(invite.projectId);
    invalidateCache(`user:${req.user.id}:projects`);
    res.json({ projectId: invite.projectId });
}));
//# sourceMappingURL=invites.js.map