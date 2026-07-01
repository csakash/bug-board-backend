import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import { remember } from '../services/response-cache.js';
import { invalidateIssueCaches, invalidateProjectCaches } from '../services/project-cache.js';
import { requireIssueAccess, requireProjectAccess } from '../lib/access.js';
import { createIssue } from '../services/issues.js';
export const issuesRouter = Router();
issuesRouter.use(requireAuth);
const boardIssueSelect = {
    id: true,
    projectId: true,
    issueKey: true,
    type: true,
    title: true,
    status: true,
    severity: true,
    createdAt: true,
    reporter: { select: { id: true, name: true, avatarUrl: true } },
    labels: { include: { label: true } },
    _count: { select: { comments: true, files: true } },
};
const issueDetailInclude = {
    reporter: { select: { id: true, name: true, avatarUrl: true } },
    assignee: { select: { id: true, name: true, avatarUrl: true } },
    labels: { include: { label: true } },
    files: {
        include: {
            file: {
                select: {
                    id: true,
                    fileName: true,
                    contentType: true,
                    sizeBytes: true,
                },
            },
        },
    },
    _count: { select: { comments: true, files: true } },
};
function serializeIssue(issue) {
    // Convert label join rows into a flat list for the client.
    const labels = issue.labels?.map((l) => l.label) ?? [];
    return { ...issue, labels };
}
// Keep only file ids the caller may attach: files they uploaded, or files in
// their own workspace. Blocks laundering a foreign file id onto an issue (which
// would otherwise grant read access via the membership-scoped download route).
async function keepAttachableFileIds(fileIds, userId, workspaceId) {
    if (!fileIds?.length)
        return [];
    const or = [{ uploadedById: userId }];
    if (workspaceId)
        or.push({ workspaceId });
    const files = await prisma.file.findMany({
        where: { id: { in: fileIds }, OR: or },
        select: { id: true },
    });
    return files.map((f) => f.id);
}
const createIssueSchema = z.object({
    type: z.string().optional(),
    title: z.string().min(1),
    description: z.string().default(''),
    status: z.string().optional(),
    severity: z.string().nullish(),
    priority: z.string().nullish(),
    environment: z.string().nullish(),
    expectedResult: z.string().nullish(),
    actualResult: z.string().nullish(),
    acceptanceCriteria: z.array(z.string()).optional(),
    stepsToReproduce: z.array(z.string()).optional(),
    labels: z.array(z.string()).optional(),
    fileIds: z.array(z.string().uuid()).optional(),
});
// List issues for a project, grouped by status.
issuesRouter.get('/projects/:projectId/issues', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id);
    const payload = await remember(`project:${req.params.projectId}:issues`, 3_000, async () => {
        const issues = await prisma.issue.findMany({
            where: { projectId: req.params.projectId },
            orderBy: { createdAt: 'desc' },
            select: boardIssueSelect,
        });
        const serialized = issues.map(serializeIssue);
        const grouped = {
            open: [],
            in_progress: [],
            resolved: [],
        };
        for (const issue of serialized) {
            if (issue.status === 'open')
                grouped.open.push(issue);
            else if (issue.status === 'in_progress')
                grouped.in_progress.push(issue);
            else if (issue.status === 'resolved')
                grouped.resolved.push(issue);
        }
        return { issues: serialized, grouped };
    });
    res.json(payload);
}));
issuesRouter.post('/projects/:projectId/issues', asyncHandler(async (req, res) => {
    await requireProjectAccess(req.params.projectId, req.user.id);
    const body = createIssueSchema.parse(req.body);
    const fileIds = await keepAttachableFileIds(body.fileIds, req.user.id, req.workspaceId);
    const issue = await createIssue(req.params.projectId, {
        ...body,
        fileIds,
        reporterId: req.user.id,
        source: 'manual',
    });
    await invalidateProjectCaches(req.params.projectId);
    res.status(201).json({ issue });
}));
// Search issues across every project the caller is a member of. Matches on
// title, issue key, and keyword aliases for severity / status / type.
const SEVERITY_VALUES = ['low', 'medium', 'high', 'critical'];
const ISSUE_TYPE_VALUES = [
    'bug',
    'feature',
    'improvement',
    'task',
    'regression',
    'investigation',
    'design',
    'documentation',
    'support',
    'question',
];
function matchStatus(q) {
    if (q === 'open')
        return 'open';
    if (['in_progress', 'in progress', 'progress', 'inprogress'].includes(q))
        return 'in_progress';
    if (['resolved', 'done', 'closed', 'complete', 'completed'].includes(q))
        return 'resolved';
    return null;
}
issuesRouter.get('/search/issues', asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const q = String(req.query.q ?? '').trim();
    if (!q) {
        res.json({ issues: [] });
        return;
    }
    const lower = q.toLowerCase();
    const or = [
        { title: { contains: q, mode: 'insensitive' } },
        { issueKey: { contains: q, mode: 'insensitive' } },
    ];
    if (SEVERITY_VALUES.includes(lower)) {
        or.push({ severity: lower });
    }
    const status = matchStatus(lower);
    if (status)
        or.push({ status });
    if (ISSUE_TYPE_VALUES.includes(lower)) {
        or.push({ type: lower });
    }
    const issues = await prisma.issue.findMany({
        where: { project: { members: { some: { userId } } }, OR: or },
        orderBy: { createdAt: 'desc' },
        take: 40,
        select: {
            ...boardIssueSelect,
            project: { select: { id: true, key: true, name: true, color: true } },
        },
    });
    res.json({ issues: issues.map(serializeIssue) });
}));
issuesRouter.get('/issues/:issueId', asyncHandler(async (req, res) => {
    await requireIssueAccess(req.params.issueId, req.user.id);
    const issue = await remember(`issue:${req.params.issueId}:detail`, 3_000, async () => prisma.issue.findUnique({
        where: { id: req.params.issueId },
        include: {
            ...issueDetailInclude,
            project: { select: { id: true, key: true, name: true } },
            comments: {
                orderBy: { createdAt: 'asc' },
                include: { author: { select: { id: true, name: true, avatarUrl: true } } },
            },
        },
    }));
    if (!issue)
        throw new HttpError(404, 'Issue not found');
    res.json({ issue: serializeIssue(issue) });
}));
const patchSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    status: z.enum(['open', 'in_progress', 'resolved']).optional(),
    severity: z.string().nullish(),
    priority: z.string().nullish(),
    assigneeId: z.string().uuid().nullish(),
});
issuesRouter.patch('/issues/:issueId', asyncHandler(async (req, res) => {
    const { projectId } = await requireIssueAccess(req.params.issueId, req.user.id);
    const body = patchSchema.parse(req.body);
    const issue = await prisma.issue.update({
        where: { id: req.params.issueId },
        data: body,
    });
    await prisma.activityEvent.create({
        data: {
            projectId,
            issueId: issue.id,
            actorId: req.user.id,
            eventType: 'issue_updated',
            payload: body,
        },
    });
    await invalidateIssueCaches(projectId, issue.id);
    res.json({ issue });
}));
const statusSchema = z.object({
    status: z.enum(['open', 'in_progress', 'resolved']),
});
issuesRouter.post('/issues/:issueId/status', asyncHandler(async (req, res) => {
    const { projectId } = await requireIssueAccess(req.params.issueId, req.user.id);
    const { status } = statusSchema.parse(req.body);
    const issue = await prisma.issue.update({
        where: { id: req.params.issueId },
        data: { status },
    });
    await prisma.activityEvent.create({
        data: {
            projectId,
            issueId: issue.id,
            actorId: req.user.id,
            eventType: 'status_changed',
            payload: { status },
        },
    });
    await invalidateIssueCaches(projectId, issue.id);
    res.json({ issue });
}));
const commentSchema = z.object({
    body: z.string().min(1),
    reviewState: z.enum(['commented', 'approved', 'requested_changes']).optional(),
    fileIds: z.array(z.string().uuid()).default([]),
});
issuesRouter.post('/issues/:issueId/comments', asyncHandler(async (req, res) => {
    const { projectId } = await requireIssueAccess(req.params.issueId, req.user.id);
    const { body, reviewState, fileIds } = commentSchema.parse(req.body);
    const attachIds = await keepAttachableFileIds(fileIds, req.user.id, req.workspaceId);
    const comment = await prisma.comment.create({
        data: {
            issueId: req.params.issueId,
            authorId: req.user.id,
            body,
            reviewState: reviewState ?? 'commented',
        },
        include: { author: { select: { id: true, name: true, avatarUrl: true } } },
    });
    if (attachIds.length) {
        await prisma.issueFile.createMany({
            data: attachIds.map((fileId) => ({ issueId: req.params.issueId, fileId })),
            skipDuplicates: true,
        });
    }
    await prisma.activityEvent.create({
        data: {
            projectId,
            issueId: req.params.issueId,
            actorId: req.user.id,
            eventType: 'comment_added',
            payload: {
                reviewState: reviewState ?? 'commented',
                attachmentCount: attachIds.length,
            },
        },
    });
    await invalidateIssueCaches(projectId, req.params.issueId);
    res.status(201).json({ comment });
}));
issuesRouter.get('/issues/:issueId/activity', asyncHandler(async (req, res) => {
    await requireIssueAccess(req.params.issueId, req.user.id);
    const events = await remember(`issue:${req.params.issueId}:activity`, 3_000, async () => prisma.activityEvent.findMany({
        where: { issueId: req.params.issueId },
        orderBy: { createdAt: 'asc' },
        include: { actor: { select: { id: true, name: true, avatarUrl: true } } },
    }));
    res.json({ events });
}));
// Lightweight related-issue suggestions: same labels or type, by keyword overlap.
issuesRouter.get('/issues/:issueId/related', asyncHandler(async (req, res) => {
    await requireIssueAccess(req.params.issueId, req.user.id);
    const related = await remember(`issue:${req.params.issueId}:related`, 5_000, async () => {
        const issue = await prisma.issue.findUnique({
            where: { id: req.params.issueId },
            include: { labels: true },
        });
        if (!issue)
            throw new HttpError(404, 'Issue not found');
        const labelIds = issue.labels.map((l) => l.labelId);
        return prisma.issue.findMany({
            where: {
                projectId: issue.projectId,
                id: { not: issue.id },
                OR: [
                    { type: issue.type },
                    labelIds.length ? { labels: { some: { labelId: { in: labelIds } } } } : {},
                ],
            },
            take: 5,
            orderBy: { createdAt: 'desc' },
            include: { labels: { include: { label: true } } },
        });
    });
    res.json({ related: related.map(serializeIssue) });
}));
//# sourceMappingURL=issues.js.map