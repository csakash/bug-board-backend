import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/client.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import { invalidateCache, remember } from '../services/response-cache.js';
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
} as const;

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
} as const;

function serializeIssue<T extends { labels?: unknown }>(issue: T) {
  // Convert label join rows into a flat list for the client.
  const labels =
    (issue.labels as { label: { id: string; name: string; color: string | null } }[])?.map(
      (l) => l.label,
    ) ?? [];
  return { ...issue, labels } as Omit<T, 'labels'> & {
    status?: string;
    labels: { id: string; name: string; color: string | null }[];
  };
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
issuesRouter.get(
  '/projects/:projectId/issues',
  asyncHandler(async (req: AuthedRequest, res) => {
    const workspaceId = req.workspaceId;
    if (!workspaceId) throw new HttpError(400, 'No workspace');

    const payload = await remember(
      `workspace:${workspaceId}:project:${req.params.projectId}:issues`,
      5_000,
      async () => {
        const issues = await prisma.issue.findMany({
          where: {
            projectId: req.params.projectId,
            project: { workspaceId },
          },
          orderBy: { createdAt: 'desc' },
          select: boardIssueSelect,
        });
        const serialized = issues.map(serializeIssue);
        const grouped = {
          open: [] as typeof serialized,
          in_progress: [] as typeof serialized,
          resolved: [] as typeof serialized,
        };

        for (const issue of serialized) {
          if (issue.status === 'open') grouped.open.push(issue);
          else if (issue.status === 'in_progress') grouped.in_progress.push(issue);
          else if (issue.status === 'resolved') grouped.resolved.push(issue);
        }

        return { issues: serialized, grouped };
      },
    );

    res.json(payload);
  }),
);

issuesRouter.post(
  '/projects/:projectId/issues',
  asyncHandler(async (req: AuthedRequest, res) => {
    const project = await prisma.project.findFirst({
      where: { id: req.params.projectId, workspaceId: req.workspaceId },
    });
    if (!project) throw new HttpError(404, 'Project not found');

    const body = createIssueSchema.parse(req.body);
    const issue = await createIssue(project.id, {
      ...body,
      reporterId: req.user!.id,
      source: 'manual',
    });
    if (req.workspaceId) {
      invalidateCache(`workspace:${req.workspaceId}:projects`);
      invalidateCache(`workspace:${req.workspaceId}:project:${project.id}`);
      invalidateCache(`workspace:${req.workspaceId}:project:${project.id}:issues`);
    }
    res.status(201).json({ issue });
  }),
);

// Search issues across every project in the workspace. Matches on title,
// issue key, and keyword aliases for severity / status / type.
const SEVERITY_VALUES = ['low', 'medium', 'high', 'critical'] as const;
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
] as const;

function matchStatus(q: string): 'open' | 'in_progress' | 'resolved' | null {
  if (q === 'open') return 'open';
  if (['in_progress', 'in progress', 'progress', 'inprogress'].includes(q)) return 'in_progress';
  if (['resolved', 'done', 'closed', 'complete', 'completed'].includes(q)) return 'resolved';
  return null;
}

issuesRouter.get(
  '/search/issues',
  asyncHandler(async (req: AuthedRequest, res) => {
    const workspaceId = req.workspaceId;
    if (!workspaceId) throw new HttpError(400, 'No workspace');

    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json({ issues: [] });
      return;
    }

    const lower = q.toLowerCase();
    const or: Prisma.IssueWhereInput[] = [
      { title: { contains: q, mode: 'insensitive' } },
      { issueKey: { contains: q, mode: 'insensitive' } },
    ];

    if ((SEVERITY_VALUES as readonly string[]).includes(lower)) {
      or.push({ severity: lower as Prisma.IssueWhereInput['severity'] });
    }
    const status = matchStatus(lower);
    if (status) or.push({ status });
    if ((ISSUE_TYPE_VALUES as readonly string[]).includes(lower)) {
      or.push({ type: lower as Prisma.IssueWhereInput['type'] });
    }

    const issues = await prisma.issue.findMany({
      where: { project: { workspaceId }, OR: or },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: {
        ...boardIssueSelect,
        project: { select: { id: true, key: true, name: true, color: true } },
      },
    });

    res.json({ issues: issues.map(serializeIssue) });
  }),
);

issuesRouter.get(
  '/issues/:issueId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const workspaceId = req.workspaceId;
    if (!workspaceId) throw new HttpError(400, 'No workspace');

    const issue = await remember(
      `workspace:${workspaceId}:issue:${req.params.issueId}`,
      5_000,
      async () =>
        prisma.issue.findFirst({
          where: {
            id: req.params.issueId,
            project: { workspaceId },
          },
          include: {
            ...issueDetailInclude,
            project: { select: { id: true, key: true, name: true } },
            comments: {
              orderBy: { createdAt: 'asc' },
              include: { author: { select: { id: true, name: true, avatarUrl: true } } },
            },
          },
        }),
    );
    if (!issue) throw new HttpError(404, 'Issue not found');
    res.json({ issue: serializeIssue(issue) });
  }),
);

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  type: z
    .enum([
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
    ])
    .optional(),
  status: z.enum(['open', 'in_progress', 'resolved']).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).nullish(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullish(),
  assigneeId: z.string().uuid().nullish(),
  environment: z.string().nullish(),
  expectedResult: z.string().nullish(),
  actualResult: z.string().nullish(),
  stepsToReproduce: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
});

issuesRouter.patch(
  '/issues/:issueId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = patchSchema.parse(req.body);
    // Scope the write to the caller's workspace (prevents cross-workspace IDOR).
    const owned = await prisma.issue.findFirst({
      where: { id: req.params.issueId, project: { workspaceId: req.workspaceId } },
      select: { id: true },
    });
    if (!owned) throw new HttpError(404, 'Issue not found');
    const issue = await prisma.issue.update({
      where: { id: req.params.issueId },
      data: body as never,
    });
    await prisma.activityEvent.create({
      data: {
        projectId: issue.projectId,
        issueId: issue.id,
        actorId: req.user!.id,
        eventType: 'issue_updated',
        payload: body,
      },
    });
    if (req.workspaceId) {
      invalidateCache(`workspace:${req.workspaceId}:project:${issue.projectId}:issues`);
      invalidateCache(`workspace:${req.workspaceId}:issue:${issue.id}`);
      invalidateCache(`issue:${issue.id}:activity`);
      invalidateCache(`issue:${issue.id}:related`);
    }
    res.json({ issue });
  }),
);

const statusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved']),
});

issuesRouter.post(
  '/issues/:issueId/status',
  asyncHandler(async (req: AuthedRequest, res) => {
    const { status } = statusSchema.parse(req.body);
    const issue = await prisma.issue.update({
      where: { id: req.params.issueId },
      data: { status },
    });
    await prisma.activityEvent.create({
      data: {
        projectId: issue.projectId,
        issueId: issue.id,
        actorId: req.user!.id,
        eventType: 'status_changed',
        payload: { status },
      },
    });
    if (req.workspaceId) {
      invalidateCache(`workspace:${req.workspaceId}:projects`);
      invalidateCache(`workspace:${req.workspaceId}:project:${issue.projectId}`);
      invalidateCache(`workspace:${req.workspaceId}:project:${issue.projectId}:issues`);
      invalidateCache(`workspace:${req.workspaceId}:issue:${issue.id}`);
      invalidateCache(`issue:${issue.id}:activity`);
      invalidateCache(`issue:${issue.id}:related`);
    }
    res.json({ issue });
  }),
);

const commentSchema = z.object({
  body: z.string().min(1),
  reviewState: z.enum(['commented', 'approved', 'requested_changes']).optional(),
  fileIds: z.array(z.string().uuid()).default([]),
});

issuesRouter.post(
  '/issues/:issueId/comments',
  asyncHandler(async (req: AuthedRequest, res) => {
    const issue = await prisma.issue.findFirst({
      where: { id: req.params.issueId, project: { workspaceId: req.workspaceId } },
    });
    if (!issue) throw new HttpError(404, 'Issue not found');
    const { body, reviewState, fileIds } = commentSchema.parse(req.body);

    const comment = await prisma.comment.create({
      data: {
        issueId: issue.id,
        authorId: req.user!.id,
        body,
        reviewState: reviewState ?? 'commented',
      },
      include: { author: { select: { id: true, name: true, avatarUrl: true } } },
    });
    if (fileIds.length) {
      await prisma.issueFile.createMany({
        data: fileIds.map((fileId) => ({ issueId: issue.id, fileId })),
        skipDuplicates: true,
      });
    }
    await prisma.activityEvent.create({
      data: {
        projectId: issue.projectId,
        issueId: issue.id,
        actorId: req.user!.id,
        eventType: 'comment_added',
        payload: {
          reviewState: reviewState ?? 'commented',
          attachmentCount: fileIds.length,
        },
      },
    });
    if (req.workspaceId) {
      invalidateCache(`workspace:${req.workspaceId}:projects`);
      invalidateCache(`workspace:${req.workspaceId}:project:${issue.projectId}`);
      invalidateCache(`workspace:${req.workspaceId}:project:${issue.projectId}:issues`);
      invalidateCache(`workspace:${req.workspaceId}:issue:${issue.id}`);
      invalidateCache(`issue:${issue.id}:activity`);
      invalidateCache(`issue:${issue.id}:related`);
    }
    res.status(201).json({ comment });
  }),
);

issuesRouter.get(
  '/issues/:issueId/activity',
  asyncHandler(async (req: AuthedRequest, res) => {
    const events = await remember(
      `issue:${req.params.issueId}:activity`,
      5_000,
      async () =>
        prisma.activityEvent.findMany({
          where: { issueId: req.params.issueId },
          orderBy: { createdAt: 'asc' },
          include: { actor: { select: { id: true, name: true, avatarUrl: true } } },
        }),
    );
    res.json({ events });
  }),
);

// Lightweight related-issue suggestions: same labels or type, by keyword overlap.
issuesRouter.get(
  '/issues/:issueId/related',
  asyncHandler(async (req: AuthedRequest, res) => {
    const related = await remember(`issue:${req.params.issueId}:related`, 5_000, async () => {
      const issue = await prisma.issue.findUnique({
        where: { id: req.params.issueId },
        include: { labels: true },
      });
      if (!issue) throw new HttpError(404, 'Issue not found');

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
  }),
);
