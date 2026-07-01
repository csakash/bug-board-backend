import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, HttpError } from '../middleware/errors.js';
import { generateAgentReply, generateIssueAgentReply, } from '../services/gemini.js';
import { buildProjectIntel, buildIssueIntel } from '../services/project-intel.js';
import { createIssue } from '../services/issues.js';
export const chatRouter = Router();
chatRouter.use(requireAuth);
function deriveThreadTitle(message) {
    const trimmed = message.trim().replace(/\s+/g, ' ');
    return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed || 'New chat';
}
function asStringList(value) {
    return Array.isArray(value) ? value.map((v) => String(v)) : [];
}
// Build a complete, readable project-context block so the assistant always has
// the full picture when chatting or drafting an issue.
function formatProjectContext(context) {
    const sections = [`Summary: ${context.summary}`];
    if (context.audience)
        sections.push(`Audience: ${context.audience}`);
    const components = asStringList(context.components);
    if (components.length)
        sections.push(`Components: ${components.join(', ')}`);
    const flows = asStringList(context.flows);
    if (flows.length)
        sections.push(`Key flows:\n${flows.map((f) => `- ${f}`).join('\n')}`);
    const terminology = asStringList(context.terminology);
    if (terminology.length)
        sections.push(`Terminology: ${terminology.join(', ')}`);
    const risks = asStringList(context.risks);
    if (risks.length)
        sections.push(`Known risks:\n${risks.map((r) => `- ${r}`).join('\n')}`);
    const openQuestions = asStringList(context.openQuestions);
    if (openQuestions.length)
        sections.push(`Open questions:\n${openQuestions.map((q) => `- ${q}`).join('\n')}`);
    const suggestedLabels = asStringList(context.suggestedLabels);
    if (suggestedLabels.length)
        sections.push(`Suggested labels: ${suggestedLabels.join(', ')}`);
    return sections.join('\n\n');
}
// Ensure the user has at least one PROJECT (board) thread, returning the most
// recent. Issue-scoped threads (issueId set) are excluded so board chat and
// issue chat never mix.
async function getOrCreateActiveThread(projectId, userId) {
    const existing = await prisma.chatThread.findFirst({
        where: { projectId, userId, issueId: null },
        orderBy: { updatedAt: 'desc' },
    });
    if (existing)
        return existing;
    return prisma.chatThread.create({ data: { projectId, userId } });
}
// Ensure the user has at least one thread for THIS issue, returning the most recent.
async function getOrCreateActiveIssueThread(projectId, issueId, userId) {
    const existing = await prisma.chatThread.findFirst({
        where: { projectId, issueId, userId },
        orderBy: { updatedAt: 'desc' },
    });
    if (existing)
        return existing;
    return prisma.chatThread.create({ data: { projectId, issueId, userId } });
}
// Load an issue and verify it belongs to the caller's active workspace.
async function loadOwnedIssue(issueId, req) {
    const issue = await prisma.issue.findFirst({
        where: { id: issueId, project: { workspaceId: req.workspaceId } },
        select: { id: true, projectId: true },
    });
    if (!issue)
        throw new HttpError(404, 'Issue not found');
    return issue;
}
// Load a thread and verify it belongs to the caller and the active workspace.
async function loadOwnedThread(threadId, req) {
    const thread = await prisma.chatThread.findUnique({
        where: { id: threadId },
        include: { project: { select: { workspaceId: true } } },
    });
    if (!thread ||
        thread.userId !== req.user.id ||
        thread.project.workspaceId !== req.workspaceId) {
        throw new HttpError(404, 'Conversation not found');
    }
    return thread;
}
// List the user's conversations for a project (ensures at least one exists).
chatRouter.get('/projects/:projectId/chat/threads', asyncHandler(async (req, res) => {
    const project = await prisma.project.findFirst({
        where: { id: req.params.projectId, workspaceId: req.workspaceId },
        select: { id: true },
    });
    if (!project)
        throw new HttpError(404, 'Project not found');
    await getOrCreateActiveThread(project.id, req.user.id);
    const threads = await prisma.chatThread.findMany({
        where: { projectId: project.id, userId: req.user.id, issueId: null },
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
}));
// Start a fresh conversation.
chatRouter.post('/projects/:projectId/chat/threads', asyncHandler(async (req, res) => {
    const project = await prisma.project.findFirst({
        where: { id: req.params.projectId, workspaceId: req.workspaceId },
        select: { id: true },
    });
    if (!project)
        throw new HttpError(404, 'Project not found');
    const thread = await prisma.chatThread.create({
        data: { projectId: project.id, userId: req.user.id },
    });
    res.status(201).json({
        thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt, messageCount: 0 },
    });
}));
// List the user's conversations for a specific issue (ensures at least one exists).
chatRouter.get('/issues/:issueId/chat/threads', asyncHandler(async (req, res) => {
    const issue = await loadOwnedIssue(req.params.issueId, req);
    await getOrCreateActiveIssueThread(issue.projectId, issue.id, req.user.id);
    const threads = await prisma.chatThread.findMany({
        where: { issueId: issue.id, userId: req.user.id },
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
}));
// Start a fresh conversation scoped to an issue.
chatRouter.post('/issues/:issueId/chat/threads', asyncHandler(async (req, res) => {
    const issue = await loadOwnedIssue(req.params.issueId, req);
    const thread = await prisma.chatThread.create({
        data: { projectId: issue.projectId, issueId: issue.id, userId: req.user.id },
    });
    res.status(201).json({
        thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt, messageCount: 0 },
    });
}));
// Fetch messages for a specific conversation.
chatRouter.get('/chat/threads/:threadId/messages', asyncHandler(async (req, res) => {
    const thread = await loadOwnedThread(req.params.threadId, req);
    const messages = await prisma.chatMessage.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: 'asc' },
    });
    res.json({ threadId: thread.id, messages });
}));
const messageSchema = z.object({
    content: z.string().min(1),
    fileIds: z.array(z.string().uuid()).default([]),
});
// Post a user message to a conversation. The agent replies with full thread
// history and live project data, and only drafts an issue card when warranted.
chatRouter.post('/chat/threads/:threadId/messages', asyncHandler(async (req, res) => {
    const thread = await loadOwnedThread(req.params.threadId, req);
    const project = await prisma.project.findFirst({
        where: { id: thread.projectId, workspaceId: req.workspaceId },
        include: { context: true, labels: true },
    });
    if (!project)
        throw new HttpError(404, 'Project not found');
    const { content, fileIds } = messageSchema.parse(req.body);
    const priorMessages = await prisma.chatMessage.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: 'asc' },
        select: { role: true, content: true },
    });
    const history = priorMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));
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
    // Issue-scoped thread: run the single-issue agent (answer + optional
    // confirm-gated action). It never drafts a new issue card.
    if (thread.issueId) {
        // Re-verify the issue still exists in this workspace (404 rather than
        // answering with an empty/hallucinated context if it vanished).
        await loadOwnedIssue(thread.issueId, req);
        const issueIntel = await buildIssueIntel(thread.issueId);
        const issueAgent = await generateIssueAgentReply({
            history,
            userMessage: content,
            projectContext: contextText,
            issueIntel,
        });
        await prisma.chatMessage.create({
            data: { threadId: thread.id, role: 'assistant', content: issueAgent.reply },
        });
        const issueTitle = thread.title ?? deriveThreadTitle(content);
        await prisma.chatThread.update({
            where: { id: thread.id },
            data: { title: issueTitle, updatedAt: new Date() },
        });
        res.status(201).json({
            threadId: thread.id,
            message: issueAgent.reply,
            suggestion: null,
            action: issueAgent.action,
            title: issueTitle,
        });
        return;
    }
    const projectIntel = await buildProjectIntel(project.id);
    const agent = await generateAgentReply({
        history,
        userMessage: content,
        projectContext: contextText,
        projectIntel,
        existingLabels: project.labels.map((l) => l.name),
        fileSummaries,
    });
    let suggestionPayload = null;
    if (agent.shouldDraftIssue && agent.issue) {
        const draft = { ...agent.issue, fileIds };
        const record = await prisma.issueSuggestion.create({
            data: {
                projectId: project.id,
                threadId: thread.id,
                createdById: req.user.id,
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
        action: null,
        title,
    });
}));
chatRouter.get('/issue-suggestions/:suggestionId', asyncHandler(async (req, res) => {
    const suggestion = await prisma.issueSuggestion.findUnique({
        where: { id: req.params.suggestionId },
    });
    if (!suggestion)
        throw new HttpError(404, 'Suggestion not found');
    res.json({ suggestion });
}));
const patchDraftSchema = z.object({ draft: z.record(z.any()) });
// Allow the user to edit the draft before adding it to the board.
chatRouter.patch('/issue-suggestions/:suggestionId', asyncHandler(async (req, res) => {
    const { draft } = patchDraftSchema.parse(req.body);
    const suggestion = await prisma.issueSuggestion.update({
        where: { id: req.params.suggestionId },
        data: { draft },
    });
    res.json({ suggestion });
}));
chatRouter.post('/issue-suggestions/:suggestionId/dismiss', asyncHandler(async (req, res) => {
    await prisma.issueSuggestion.update({
        where: { id: req.params.suggestionId },
        data: { status: 'dismissed' },
    });
    res.json({ ok: true });
}));
// Turn an accepted suggestion into a real board issue.
chatRouter.post('/issue-suggestions/:suggestionId/add-to-board', asyncHandler(async (req, res) => {
    const suggestion = await prisma.issueSuggestion.findUnique({
        where: { id: req.params.suggestionId },
    });
    if (!suggestion)
        throw new HttpError(404, 'Suggestion not found');
    if (suggestion.status === 'accepted') {
        throw new HttpError(409, 'Suggestion already added to board');
    }
    // Allow the client to send a final edited draft with the request.
    const draft = (req.body?.draft ?? suggestion.draft);
    const issue = await createIssue(suggestion.projectId, {
        type: draft.type,
        title: draft.title ?? 'New issue',
        description: draft.description ?? '',
        status: draft.status,
        severity: draft.severity,
        priority: draft.priority,
        environment: draft.environment,
        expectedResult: draft.expectedResult,
        actualResult: draft.actualResult,
        acceptanceCriteria: draft.acceptanceCriteria ?? [],
        stepsToReproduce: draft.stepsToReproduce ?? [],
        labels: draft.labels ?? [],
        fileIds: draft.fileIds ?? [],
        reporterId: req.user.id,
        source: 'ai_chat',
        aiConfidence: suggestion.confidence,
    });
    await prisma.issueSuggestion.update({
        where: { id: suggestion.id },
        data: { status: 'accepted', createdIssueId: issue.id },
    });
    res.status(201).json({ issue });
}));
//# sourceMappingURL=chat.js.map