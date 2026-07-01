import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import { requireProjectAccess } from '../lib/access.js';
import { generateAgentReply, type AgentTurn } from '../services/gemini.js';
import { buildProjectIntel } from '../services/project-intel.js';
import { createIssue } from '../services/issues.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

function deriveThreadTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed || 'New chat';
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).map((v) => String(v)) : [];
}

// Build a complete, readable project-context block so the assistant always has
// the full picture when chatting or drafting an issue.
function formatProjectContext(context: {
  summary: string;
  audience: string | null;
  components: unknown;
  flows: unknown;
  terminology: unknown;
  risks: unknown;
  openQuestions: unknown;
  suggestedLabels: unknown;
}): string {
  const sections: string[] = [`Summary: ${context.summary}`];
  if (context.audience) sections.push(`Audience: ${context.audience}`);

  const components = asStringList(context.components);
  if (components.length) sections.push(`Components: ${components.join(', ')}`);

  const flows = asStringList(context.flows);
  if (flows.length) sections.push(`Key flows:\n${flows.map((f) => `- ${f}`).join('\n')}`);

  const terminology = asStringList(context.terminology);
  if (terminology.length) sections.push(`Terminology: ${terminology.join(', ')}`);

  const risks = asStringList(context.risks);
  if (risks.length) sections.push(`Known risks:\n${risks.map((r) => `- ${r}`).join('\n')}`);

  const openQuestions = asStringList(context.openQuestions);
  if (openQuestions.length)
    sections.push(`Open questions:\n${openQuestions.map((q) => `- ${q}`).join('\n')}`);

  const suggestedLabels = asStringList(context.suggestedLabels);
  if (suggestedLabels.length) sections.push(`Suggested labels: ${suggestedLabels.join(', ')}`);

  return sections.join('\n\n');
}

// Ensure the user has at least one thread for this project, returning the most recent.
async function getOrCreateActiveThread(projectId: string, userId: string) {
  const existing = await prisma.chatThread.findFirst({
    where: { projectId, userId },
    orderBy: { updatedAt: 'desc' },
  });
  if (existing) return existing;
  return prisma.chatThread.create({ data: { projectId, userId } });
}

// Load a thread and verify it belongs to the caller, who must still be a member
// of the thread's project. Chat threads are per-user, so we also gate on userId.
async function loadOwnedThread(threadId: string, req: AuthedRequest) {
  const thread = await prisma.chatThread.findUnique({ where: { id: threadId } });
  if (!thread || thread.userId !== req.user!.id) {
    throw new HttpError(404, 'Conversation not found');
  }
  await requireProjectAccess(thread.projectId, req.user!.id);
  return thread;
}

// Load a suggestion and verify the caller is a member of its project.
async function loadOwnedSuggestion(suggestionId: string, req: AuthedRequest) {
  const suggestion = await prisma.issueSuggestion.findUnique({ where: { id: suggestionId } });
  if (!suggestion) throw new HttpError(404, 'Suggestion not found');
  await requireProjectAccess(suggestion.projectId, req.user!.id);
  return suggestion;
}

// List the user's conversations for a project (ensures at least one exists).
chatRouter.get(
  '/projects/:projectId/chat/threads',
  asyncHandler(async (req: AuthedRequest, res) => {
    await requireProjectAccess(req.params.projectId, req.user!.id);

    await getOrCreateActiveThread(req.params.projectId, req.user!.id);

    const threads = await prisma.chatThread.findMany({
      where: { projectId: req.params.projectId, userId: req.user!.id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });

    res.json({
      threads: threads.map((t) => ({
        id: t.id,
        title: t.title,
        updatedAt: t.updatedAt,
        messageCount: t._count.messages,
      })),
    });
  }),
);

// Start a fresh conversation.
chatRouter.post(
  '/projects/:projectId/chat/threads',
  asyncHandler(async (req: AuthedRequest, res) => {
    await requireProjectAccess(req.params.projectId, req.user!.id);

    const thread = await prisma.chatThread.create({
      data: { projectId: req.params.projectId, userId: req.user!.id },
    });
    res.status(201).json({
      thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt, messageCount: 0 },
    });
  }),
);

// Fetch messages for a specific conversation.
chatRouter.get(
  '/chat/threads/:threadId/messages',
  asyncHandler(async (req: AuthedRequest, res) => {
    const thread = await loadOwnedThread(req.params.threadId, req);
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

// Post a user message to a conversation. The agent replies with full thread
// history and live project data, and only drafts an issue card when warranted.
chatRouter.post(
  '/chat/threads/:threadId/messages',
  asyncHandler(async (req: AuthedRequest, res) => {
    const thread = await loadOwnedThread(req.params.threadId, req);
    const project = await prisma.project.findUnique({
      where: { id: thread.projectId },
      include: { context: true, labels: true },
    });
    if (!project) throw new HttpError(404, 'Project not found');

    const { content, fileIds } = messageSchema.parse(req.body);

    const priorMessages = await prisma.chatMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    });
    const history: AgentTurn[] = priorMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    await prisma.chatMessage.create({
      data: { threadId: thread.id, role: 'user', content, fileIds },
    });

    const files = fileIds.length
      ? await prisma.file.findMany({ where: { id: { in: fileIds } } })
      : [];
    const fileSummaries = files.map((f) => `${f.fileName} (${f.contentType})`);

    const contextText = project.context
      ? formatProjectContext(project.context)
      : project.description;

    const projectIntel = await buildProjectIntel(project.id);

    const agent = await generateAgentReply({
      history,
      userMessage: content,
      projectContext: contextText,
      projectIntel,
      existingLabels: project.labels.map((l) => l.name),
      fileSummaries,
    });

    let suggestionPayload: { id: string; draft: Record<string, unknown>; confidence: number | null } | null =
      null;

    if (agent.shouldDraftIssue && agent.issue) {
      const draft = { ...agent.issue, fileIds };
      const record = await prisma.issueSuggestion.create({
        data: {
          projectId: project.id,
          threadId: thread.id,
          createdById: req.user!.id,
          draft,
          confidence: agent.issue.confidence,
        },
      });
      suggestionPayload = { id: record.id, draft, confidence: agent.issue.confidence };
    }

    await prisma.chatMessage.create({
      data: { threadId: thread.id, role: 'assistant', content: agent.reply },
    });

    // Title the thread from its first user message, and bump its updatedAt.
    const title = thread.title ?? deriveThreadTitle(content);
    await prisma.chatThread.update({
      where: { id: thread.id },
      data: { title, updatedAt: new Date() },
    });

    res.status(201).json({
      threadId: thread.id,
      message: agent.reply,
      suggestion: suggestionPayload,
      title,
    });
  }),
);

chatRouter.get(
  '/issue-suggestions/:suggestionId',
  asyncHandler(async (req: AuthedRequest, res) => {
    const suggestion = await loadOwnedSuggestion(req.params.suggestionId, req);
    res.json({ suggestion });
  }),
);

const patchDraftSchema = z.object({ draft: z.record(z.any()) });

// Allow the user to edit the draft before adding it to the board.
chatRouter.patch(
  '/issue-suggestions/:suggestionId',
  asyncHandler(async (req: AuthedRequest, res) => {
    await loadOwnedSuggestion(req.params.suggestionId, req);
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
    await loadOwnedSuggestion(req.params.suggestionId, req);
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
    const suggestion = await loadOwnedSuggestion(req.params.suggestionId, req);
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
