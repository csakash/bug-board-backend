import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import { invalidateCache, remember } from '../services/response-cache.js';
import { invalidateProjectCaches } from '../services/project-cache.js';
import { requireProjectAccess } from '../lib/access.js';
import { buildAcceptUrl, inviteToProject } from '../services/invites.js';
import { generateProjectContext } from '../services/gemini.js';
import { getObjectBytes } from '../files/r2.js';
import { isR2Configured } from '../config/env.js';
export const projectsRouter = Router();
const createSchema = z.object({
    name: z.string().min(1).max(120),
    key: z
        .string()
        .min(2)
        .max(8)
        .regex(/^[A-Za-z]+$/, 'Key must be letters only')
        .optional(),
    description: z.string().min(1),
    color: z.string().optional(),
    links: z.array(z.string()).default([]),
    fileIds: z.array(z.string().uuid()).default([]),
    screenshotIds: z.array(z.string().uuid()).default([]),
    // Optional teammate emails to invite at creation time.
    invites: z.array(z.string().email()).max(20).default([]),
});
const updateSchema = z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().min(1).optional(),
    color: z.string().optional(),
});
const inviteSchema = z.object({ email: z.string().email() });
function deriveKey(name) {
    const letters = name.replace(/[^A-Za-z]/g, '').toUpperCase();
    return (letters.slice(0, 3) || 'PRJ').padEnd(2, 'X');
}
// Generate and persist the AI project context (runs inline, fire-and-forget).
async function runContextGeneration(projectId) {
    try {
        await prisma.project.update({
            where: { id: projectId },
            data: { contextStatus: 'generating' },
        });
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: { files: { include: { file: true } } },
        });
        if (!project)
            return;
        const fileSummaries = project.files.map((pf) => `${pf.file.fileName} (${pf.file.contentType}, ${pf.purpose})`);
        // Pull a handful of screenshots so the model can "see" the product and build
        // richer context. Bounded by count and size to stay within request limits.
        const MAX_IMAGES = 6;
        const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
        const images = [];
        if (isR2Configured) {
            const imageFiles = project.files
                .filter((pf) => pf.file.contentType.startsWith('image/') &&
                (pf.purpose === 'screenshot' || pf.purpose === 'context'))
                .slice(0, MAX_IMAGES);
            for (const pf of imageFiles) {
                try {
                    const bytes = await getObjectBytes(pf.file.objectKey);
                    if (bytes.length > MAX_IMAGE_BYTES)
                        continue;
                    images.push({ data: bytes.toString('base64'), mimeType: pf.file.contentType });
                }
                catch (err) {
                    console.error('Failed to load screenshot for context generation:', pf.file.id, err);
                }
            }
        }
        const result = await generateProjectContext({
            name: project.name,
            description: project.description,
            fileSummaries,
            links: [],
            images,
        });
        await prisma.projectContext.upsert({
            where: { projectId },
            create: {
                projectId,
                summary: result.summary,
                audience: result.audience,
                terminology: result.terminology,
                flows: result.flows,
                components: result.components,
                suggestedLabels: result.suggestedLabels,
                suggestedTemplates: result.suggestedTemplates,
                risks: result.risks,
                openQuestions: result.openQuestions,
                sourceFileIds: project.files.map((pf) => pf.fileId),
                model: 'gemini',
            },
            update: {
                summary: result.summary,
                audience: result.audience,
                terminology: result.terminology,
                flows: result.flows,
                components: result.components,
                suggestedLabels: result.suggestedLabels,
                suggestedTemplates: result.suggestedTemplates,
                risks: result.risks,
                openQuestions: result.openQuestions,
            },
        });
        // Seed suggested labels onto the project.
        for (const label of result.suggestedLabels.slice(0, 12)) {
            await prisma.label
                .create({ data: { projectId, name: label } })
                .catch(() => undefined);
        }
        await prisma.project.update({
            where: { id: projectId },
            data: { contextStatus: 'ready' },
        });
        await invalidateProjectCaches(projectId);
    }
    catch (err) {
        console.error('Context generation failed:', err);
        const failedProject = await prisma.project
            .update({ where: { id: projectId }, data: { contextStatus: 'failed' } })
            .catch(() => undefined);
        if (failedProject) {
            await invalidateProjectCaches(failedProject.id);
        }
    }
}
projectsRouter.use(requireAuth);
// List projects the caller is a member of (owner or member).
projectsRouter.get('/', asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const data = await remember(`user:${userId}:projects`, 5_000, async () => {
        const projects = await prisma.project.findMany({
            where: { members: { some: { userId } } },
            orderBy: { createdAt: 'asc' },
            select: {
                id: true,
                name: true,
                key: true,
                description: true,
                color: true,
                contextStatus: true,
                context: { select: { summary: true } },
                _count: { select: { issues: true, members: true } },
            },
        });
        const activeCounts = await prisma.issue.groupBy({
            by: ['projectId'],
            where: {
                project: { members: { some: { userId } } },
                status: { not: 'resolved' },
            },
            _count: { _all: true },
        });
        const activeCountByProjectId = new Map(activeCounts.map((entry) => [entry.projectId, entry._count._all]));
        return projects.map((p) => ({
            id: p.id,
            name: p.name,
            key: p.key,
            description: p.description,
            summary: p.context?.summary ?? null,
            color: p.color,
            contextStatus: p.contextStatus,
            issueCount: p._count.issues,
            activeCount: activeCountByProjectId.get(p.id) ?? 0,
            // A project is "shared" once it has more than just its owner.
            memberCount: p._count.members,
        }));
    });
    res.json({ projects: data });
}));
projectsRouter.post('/', asyncHandler(async (req, res) => {
    const workspaceId = req.workspaceId;
    if (!workspaceId)
        throw new HttpError(400, 'No workspace');
    const body = createSchema.parse(req.body);
    const userId = req.user.id;
    let key = (body.key ?? deriveKey(body.name)).toUpperCase();
    // Ensure key uniqueness within the workspace.
    const existingKeys = new Set((await prisma.project.findMany({
        where: { workspaceId },
        select: { key: true },
    })).map((p) => p.key));
    let suffix = 1;
    const base = key;
    while (existingKeys.has(key)) {
        key = `${base}${suffix++}`;
    }
    // Create the project and its owner membership together.
    const project = await prisma.project.create({
        data: {
            workspaceId,
            name: body.name,
            key,
            description: body.description,
            color: body.color,
            createdById: userId,
            members: { create: { userId, role: 'owner' } },
            files: {
                create: [
                    ...body.fileIds.map((fileId) => ({ fileId, purpose: 'context' })),
                    ...body.screenshotIds.map((fileId) => ({
                        fileId,
                        purpose: 'screenshot',
                    })),
                ],
            },
        },
    });
    // Send any invites requested at creation. Deduped + never throws.
    const inviteResults = [];
    const seen = new Set();
    for (const rawEmail of body.invites) {
        const email = rawEmail.trim().toLowerCase();
        if (!email || seen.has(email))
            continue;
        seen.add(email);
        const outcome = await inviteToProject({
            projectId: project.id,
            email,
            invitedById: userId,
            inviterName: req.user.name,
            projectName: project.name,
        });
        inviteResults.push({ email, ...outcome });
    }
    await invalidateProjectCaches(project.id);
    // Kick off AI context generation without blocking the response.
    void runContextGeneration(project.id);
    res.status(201).json({ project, invites: inviteResults });
}));
projectsRouter.get('/:projectId', asyncHandler(async (req, res) => {
    const member = await requireProjectAccess(req.params.projectId, req.user.id);
    const project = await remember(`project:${req.params.projectId}:detail`, 3_000, async () => prisma.project.findUnique({
        where: { id: req.params.projectId },
        include: {
            context: true,
            labels: true,
            members: {
                orderBy: { createdAt: 'asc' },
                include: {
                    user: { select: { id: true, name: true, email: true, avatarUrl: true } },
                },
            },
            files: {
                orderBy: { createdAt: 'asc' },
                include: {
                    file: {
                        select: {
                            id: true,
                            fileName: true,
                            contentType: true,
                            sizeBytes: true,
                            createdAt: true,
                        },
                    },
                },
            },
        },
    }));
    if (!project)
        throw new HttpError(404, 'Project not found');
    // Only owners see pending invites (not cached — cheap and owner-only).
    const pendingInvites = member.role === 'owner'
        ? (await prisma.projectInvite.findMany({
            where: {
                projectId: project.id,
                status: 'pending',
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
            select: { id: true, email: true, createdAt: true, expiresAt: true, token: true },
        })).map(({ token, ...inv }) => ({ ...inv, acceptUrl: buildAcceptUrl(token) }))
        : [];
    const members = project.members.map((m) => ({
        userId: m.userId,
        role: m.role,
        name: m.user.name,
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
        joinedAt: m.createdAt,
    }));
    res.json({
        project: {
            ...project,
            members,
            myRole: member.role,
            pendingInvites,
        },
    });
}));
projectsRouter.patch('/:projectId', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id, 'owner');
    const body = updateSchema.parse(req.body);
    await prisma.project.update({
        where: { id: req.params.projectId },
        data: body,
    });
    await invalidateProjectCaches(req.params.projectId);
    res.json({ ok: true });
}));
projectsRouter.delete('/:projectId', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id, 'owner');
    // Snapshot member ids before delete so we can clear their list caches.
    await invalidateProjectCaches(req.params.projectId);
    // Related rows (issues, labels, files, threads, context, suggestions,
    // relations, activity, members, invites) cascade via onDelete: Cascade.
    await prisma.project.delete({ where: { id: req.params.projectId } });
    res.json({ ok: true });
}));
projectsRouter.get('/:projectId/context', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id);
    const context = await remember(`project:${req.params.projectId}:context`, 10_000, async () => prisma.projectContext.findUnique({
        where: { projectId: req.params.projectId },
    }));
    res.json({ context });
}));
projectsRouter.post('/:projectId/context/regenerate', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id, 'owner');
    await invalidateProjectCaches(req.params.projectId);
    void runContextGeneration(req.params.projectId);
    res.json({ ok: true, contextStatus: 'generating' });
}));
// ---------- Invites (owner-only) ----------
projectsRouter.get('/:projectId/invites', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id, 'owner');
    const rows = await prisma.projectInvite.findMany({
        where: {
            projectId: req.params.projectId,
            status: 'pending',
            expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, email: true, createdAt: true, expiresAt: true, token: true },
    });
    const invites = rows.map(({ token, ...inv }) => ({ ...inv, acceptUrl: buildAcceptUrl(token) }));
    res.json({ invites });
}));
projectsRouter.post('/:projectId/invites', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id, 'owner');
    const { email } = inviteSchema.parse(req.body);
    const project = await prisma.project.findUnique({
        where: { id: req.params.projectId },
        select: { name: true },
    });
    if (!project)
        throw new HttpError(404, 'Project not found');
    const outcome = await inviteToProject({
        projectId: req.params.projectId,
        email,
        invitedById: req.user.id,
        inviterName: req.user.name,
        projectName: project.name,
    });
    if (outcome.alreadyMember) {
        res.json({ alreadyMember: true });
        return;
    }
    res.status(201).json({
        invite: outcome.invite,
        emailSent: outcome.emailSent,
        acceptUrl: outcome.invite ? buildAcceptUrl(outcome.invite.token) : undefined,
    });
}));
projectsRouter.delete('/:projectId/invites/:inviteId', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id, 'owner');
    const invite = await prisma.projectInvite.findFirst({
        where: { id: req.params.inviteId, projectId: req.params.projectId },
    });
    if (!invite)
        throw new HttpError(404, 'Invite not found');
    if (invite.status === 'pending') {
        await prisma.projectInvite.update({
            where: { id: invite.id },
            data: { status: 'revoked' },
        });
    }
    res.json({ ok: true });
}));
// ---------- Members ----------
projectsRouter.get('/:projectId/members', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id);
    const members = await prisma.projectMember.findMany({
        where: { projectId: req.params.projectId },
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
    });
    res.json({
        members: members.map((m) => ({
            userId: m.userId,
            role: m.role,
            name: m.user.name,
            email: m.user.email,
            avatarUrl: m.user.avatarUrl,
            joinedAt: m.createdAt,
        })),
    });
}));
projectsRouter.delete('/:projectId/members/:userId', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id, 'owner');
    const target = await prisma.projectMember.findUnique({
        where: {
            projectId_userId: { projectId: req.params.projectId, userId: req.params.userId },
        },
    });
    if (!target)
        throw new HttpError(404, 'Member not found');
    // Guard the last owner: a project must always keep at least one owner.
    if (target.role === 'owner') {
        const ownerCount = await prisma.projectMember.count({
            where: { projectId: req.params.projectId, role: 'owner' },
        });
        if (ownerCount <= 1) {
            throw new HttpError(400, 'Cannot remove the last owner of a project');
        }
    }
    await prisma.projectMember.delete({ where: { id: target.id } });
    await invalidateProjectCaches(req.params.projectId);
    // The removed user is no longer a member, so the cache sweep above won't
    // touch their list cache — clear it explicitly so they lose access promptly.
    invalidateCache(`user:${req.params.userId}:projects`);
    res.json({ ok: true });
}));
//# sourceMappingURL=projects.js.map