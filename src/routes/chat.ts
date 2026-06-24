import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import { generateIssueSuggestion } from '../services/gemini.js';
import { createIssue } from '../services/issues.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

async function getOrCreateThread(projectId: string, userId: string) {
  const existing = await prisma.chatThread.findFirst({
    where: { projectId, userId },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;
  return prisma.chatThread.create({ data: { projectId, userId } });
}

// Fetch chat history for the project's thread.
chatRouter.get(
  '/projects/:projectId/chat/messages',
  asyncHandler(async (req: AuthedRequest, res) => {
    const thread = await getOrCreateThread(req.params.projectId, req.user!.id);
    const messages = await prisma.chatMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ threadId: thread.id, messages });
  }),
);

const messageSchema = z.object({
  content: z.string().min(1),
  fileIds: z.array(z.string().uuid()).default([]),
});

// Post a user message and get back an AI-generated suggested issue card.
chatRouter.post(
  '/projects/:projectId/chat/messages',
  asyncHandler(async (req: AuthedRequest, res) => {
    const project = await prisma.project.findFirst({
      where: { id: req.params.projectId, workspaceId: req.workspaceId },
      include: { context: true, labels: true },
    });
    if (!project) throw new HttpError(404, 'Project not found');

    const { content, fileIds } = messageSchema.parse(req.body);
    const thread = await getOrCreateThread(project.id, req.user!.id);

    await prisma.chatMessage.create({
      data: { threadId: thread.id, role: 'user', content, fileIds },
    });

    const files = fileIds.length
      ? await prisma.file.findMany({ where: { id: { in: fileIds } } })
      : [];
    const fileSummaries = files.map((f) => `${f.fileName} (${f.contentType})`);

    const contextText = project.context
      ? `${project.context.summary}\nComponents: ${(project.context.components as string[]).join(', ')}`
      : project.description;

    const suggestion = await generateIssueSuggestion({
      message: content,
      projectContext: contextText,
      existingLabels: project.labels.map((l) => l.name),
      fileSummaries,
    });

    const draft = { ...suggestion, fileIds };
    const record = await prisma.issueSuggestion.create({
      data: {
        projectId: project.id,
        threadId: thread.id,
        createdById: req.user!.id,
        draft,
        confidence: suggestion.confidence,
      },
    });

    const assistantText = suggestion.clarifyingQuestions.length
      ? `I drafted a card, but a couple of things would help: ${suggestion.clarifyingQuestions.join(' ')}`
      : 'Here is a structured issue card I drafted from that. Review it, then add it to the board when it looks right.';

    await prisma.chatMessage.create({
      data: { threadId: thread.id, role: 'assistant', content: assistantText },
    });

    res.status(201).json({
      message: assistantText,
      suggestion: { id: record.id, draft, confidence: suggestion.confidence },
    });
  }),
);

chatRouter.get(
  '/issue-suggestions/:suggestionId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const suggestion = await prisma.issueSuggestion.findUnique({
      where: { id: req.params.suggestionId },
    });
    if (!suggestion) throw new HttpError(404, 'Suggestion not found');
    res.json({ suggestion });
  }),
);

const patchDraftSchema = z.object({ draft: z.record(z.any()) });

// Allow the user to edit the draft before adding it to the board.
chatRouter.patch(
  '/issue-suggestions/:suggestionId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const { draft } = patchDraftSchema.parse(req.body);
    const suggestion = await prisma.issueSuggestion.update({
      where: { id: req.params.suggestionId },
      data: { draft },
    });
    res.json({ suggestion });
  }),
);

chatRouter.post(
  '/issue-suggestions/:suggestionId/dismiss',
  asyncHandler(async (req: AuthedRequest, res) => {
    await prisma.issueSuggestion.update({
      where: { id: req.params.suggestionId },
      data: { status: 'dismissed' },
    });
    res.json({ ok: true });
  }),
);

// Turn an accepted suggestion into a real board issue.
chatRouter.post(
  '/issue-suggestions/:suggestionId/add-to-board',
  asyncHandler(async (req: AuthedRequest, res) => {
    const suggestion = await prisma.issueSuggestion.findUnique({
      where: { id: req.params.suggestionId },
    });
    if (!suggestion) throw new HttpError(404, 'Suggestion not found');
    if (suggestion.status === 'accepted') {
      throw new HttpError(409, 'Suggestion already added to board');
    }

    // Allow the client to send a final edited draft with the request.
    const draft = (req.body?.draft ?? suggestion.draft) as Record<string, unknown>;

    const issue = await createIssue(suggestion.projectId, {
      type: draft.type as string,
      title: (draft.title as string) ?? 'New issue',
      description: (draft.description as string) ?? '',
      status: draft.status as string,
      severity: draft.severity as string | null,
      priority: draft.priority as string | null,
      environment: draft.environment as string | null,
      expectedResult: draft.expectedResult as string | null,
      actualResult: draft.actualResult as string | null,
      acceptanceCriteria: (draft.acceptanceCriteria as string[]) ?? [],
      stepsToReproduce: (draft.stepsToReproduce as string[]) ?? [],
      labels: (draft.labels as string[]) ?? [],
      fileIds: (draft.fileIds as string[]) ?? [],
      reporterId: req.user!.id,
      source: 'ai_chat',
      aiConfidence: suggestion.confidence,
    });

    await prisma.issueSuggestion.update({
      where: { id: suggestion.id },
      data: { status: 'accepted', createdIssueId: issue.id },
    });

    res.status(201).json({ issue });
  }),
);
