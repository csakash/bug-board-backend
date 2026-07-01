import { GoogleGenerativeAI } from '@google/generative-ai';
import { env, isGeminiConfigured } from '../config/env.js';

const genAI = isGeminiConfigured ? new GoogleGenerativeAI(env.gemini.apiKey) : null;

export interface ProjectContextResult {
  summary: string;
  audience: string;
  terminology: string[];
  flows: string[];
  components: string[];
  suggestedLabels: string[];
  suggestedTemplates: string[];
  risks: string[];
  openQuestions: string[];
}

export interface IssueSuggestionResult {
  type: string;
  title: string;
  description: string;
  status: string;
  severity: string | null;
  priority: string | null;
  labels: string[];
  environment: string | null;
  stepsToReproduce: string[];
  expectedResult: string | null;
  actualResult: string | null;
  acceptanceCriteria: string[];
  relatedIssueIds: string[];
  confidence: number;
  clarifyingQuestions: string[];
}

const ISSUE_TYPES = [
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

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

function extractJson<T>(text: string): T {
  // Models sometimes wrap JSON in ```json fences — strip them.
  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No JSON object found in model output');
  }
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

export async function generateProjectContext(input: {
  name: string;
  description: string;
  fileSummaries: string[];
  links: string[];
  images?: { data: string; mimeType: string }[];
}): Promise<ProjectContextResult> {
  const fallback: ProjectContextResult = {
    summary: input.description,
    audience: '',
    terminology: [],
    flows: [],
    components: [],
    suggestedLabels: [],
    suggestedTemplates: [],
    risks: [],
    openQuestions: [],
  };

  if (!genAI) return fallback;

  const images = input.images ?? [];
  const model = genAI.getGenerativeModel({ model: env.gemini.model });
  const prompt = `You are an assistant that builds a reusable project context profile for an issue tracker.
The tracker handles ALL product work: bugs, features, improvements, tasks, regressions, investigations, design, documentation, support, and questions.

Project name: ${input.name}
Project description: ${input.description}
Attached resources:
${input.fileSummaries.map((s) => `- ${s}`).join('\n') || '- none'}
Links:
${input.links.map((l) => `- ${l}`).join('\n') || '- none'}
${
  images.length
    ? `\n${images.length} product screenshot(s) are attached below. Carefully study them to infer the UI, key flows, components, audience, and terminology, and reflect what you see in your answer.`
    : ''
}

Return ONLY a JSON object with this exact shape:
{
  "summary": string,
  "audience": string,
  "terminology": string[],
  "flows": string[],
  "components": string[],
  "suggestedLabels": string[],
  "suggestedTemplates": string[],
  "risks": string[],
  "openQuestions": string[]
}`;

  try {
    const imageParts = images.map((img) => ({
      inlineData: { data: img.data, mimeType: img.mimeType },
    }));
    const result = await model.generateContent(
      imageParts.length ? [prompt, ...imageParts] : prompt,
    );
    const parsed = extractJson<Partial<ProjectContextResult>>(result.response.text());
    return { ...fallback, ...parsed };
  } catch (err) {
    console.error('generateProjectContext failed:', err);
    return fallback;
  }
}

export async function generateIssueSuggestion(input: {
  message: string;
  projectContext: string;
  existingLabels: string[];
  fileSummaries: string[];
}): Promise<IssueSuggestionResult> {
  const fallback: IssueSuggestionResult = {
    type: 'bug',
    title: input.message.slice(0, 80) || 'New issue',
    description: input.message,
    status: 'open',
    severity: 'medium',
    priority: 'medium',
    labels: [],
    environment: null,
    stepsToReproduce: [],
    expectedResult: null,
    actualResult: null,
    acceptanceCriteria: [],
    relatedIssueIds: [],
    confidence: 0.4,
    clarifyingQuestions: [],
  };

  if (!genAI) return fallback;

  const model = genAI.getGenerativeModel({ model: env.gemini.model });
  const prompt = `You convert a rough product report into a single structured issue card.
The issue may be a bug, feature, improvement, task, regression, investigation, design, documentation, support, or question. Choose the most fitting "type" from: ${ISSUE_TYPES.join(', ')}.

If it is a bug/regression, fill stepsToReproduce, expectedResult and actualResult.
If it is a feature/improvement, fill acceptanceCriteria and leave reproduction fields empty.
If the report is too vague, populate clarifyingQuestions.

Project context:
${input.projectContext || 'none provided'}

Existing project labels: ${input.existingLabels.join(', ') || 'none'}

Attached files:
${input.fileSummaries.map((s) => `- ${s}`).join('\n') || '- none'}

User report:
"""
${input.message}
"""

Return ONLY a JSON object with this exact shape:
{
  "type": string,
  "title": string,
  "description": string,
  "status": "open" | "in_progress" | "resolved",
  "severity": "low" | "medium" | "high" | "critical" | null,
  "priority": "low" | "medium" | "high" | "urgent" | null,
  "labels": string[],
  "environment": string | null,
  "stepsToReproduce": string[],
  "expectedResult": string | null,
  "actualResult": string | null,
  "acceptanceCriteria": string[],
  "relatedIssueIds": [],
  "confidence": number,
  "clarifyingQuestions": string[]
}`;

  try {
    const result = await model.generateContent(prompt);
    const parsed = extractJson<Partial<IssueSuggestionResult>>(result.response.text());
    const type = ISSUE_TYPES.includes(String(parsed.type)) ? String(parsed.type) : 'bug';
    return { ...fallback, ...parsed, type };
  } catch (err) {
    console.error('generateIssueSuggestion failed:', err);
    return fallback;
  }
}

export interface AgentReplyResult {
  reply: string;
  shouldDraftIssue: boolean;
  issue: IssueSuggestionResult | null;
}

export interface AgentTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Conversational agent that has the full thread history plus live project data.
// It replies naturally and only drafts a structured issue card when the user is
// actually reporting a problem or requesting trackable work.
export async function generateAgentReply(input: {
  history: AgentTurn[];
  userMessage: string;
  projectContext: string;
  projectIntel: string;
  existingLabels: string[];
  fileSummaries: string[];
}): Promise<AgentReplyResult> {
  const fallbackIssue: IssueSuggestionResult = {
    type: 'bug',
    title: input.userMessage.slice(0, 80) || 'New issue',
    description: input.userMessage,
    status: 'open',
    severity: 'medium',
    priority: 'medium',
    labels: [],
    environment: null,
    stepsToReproduce: [],
    expectedResult: null,
    actualResult: null,
    acceptanceCriteria: [],
    relatedIssueIds: [],
    confidence: 0.4,
    clarifyingQuestions: [],
  };

  if (!genAI) {
    return {
      reply:
        'AI is not configured in this environment, so I drafted a basic card from your message. Review and edit it before adding it to the board.',
      shouldDraftIssue: true,
      issue: fallbackIssue,
    };
  }

  const model = genAI.getGenerativeModel({ model: env.gemini.model });
  const historyText =
    input.history
      .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
      .join('\n') || '(no earlier messages)';

  const prompt = `You are Bugbot, an AI assistant embedded inside a specific project of an issue tracker.
You can: answer questions about the project, summarize issue status and ongoing discussion using the LIVE PROJECT DATA, and when the user reports a bug or requests trackable work, draft ONE structured issue card.

Behaviour rules:
- ALWAYS write a helpful, conversational "reply" that directly addresses the user's latest message, using the full conversation so far for context.
- If the user asks about status, counts, what's happening, or a specific issue, answer from LIVE PROJECT DATA and set shouldDraftIssue=false, issue=null.
- Only set shouldDraftIssue=true and fill "issue" when the user is clearly reporting a problem or requesting work that should become a tracked issue.
- If a report is too vague to file, ask for the missing details in "reply" and keep shouldDraftIssue=false.
- For issue "type", choose the best fit from: ${ISSUE_TYPES.join(', ')}.

PROJECT CONTEXT:
${input.projectContext || 'none provided'}

LIVE PROJECT DATA:
${input.projectIntel}

EXISTING PROJECT LABELS: ${input.existingLabels.join(', ') || 'none'}

ATTACHED FILES (current message):
${input.fileSummaries.map((s) => `- ${s}`).join('\n') || '- none'}

CONVERSATION SO FAR:
${historyText}

NEW USER MESSAGE:
"""
${input.userMessage}
"""

Return ONLY a JSON object with this exact shape:
{
  "reply": string,
  "shouldDraftIssue": boolean,
  "issue": null | {
    "type": string,
    "title": string,
    "description": string,
    "status": "open" | "in_progress" | "resolved",
    "severity": "low" | "medium" | "high" | "critical" | null,
    "priority": "low" | "medium" | "high" | "urgent" | null,
    "labels": string[],
    "environment": string | null,
    "stepsToReproduce": string[],
    "expectedResult": string | null,
    "actualResult": string | null,
    "acceptanceCriteria": string[],
    "relatedIssueIds": [],
    "confidence": number,
    "clarifyingQuestions": string[]
  }
}`;

  try {
    const result = await model.generateContent(prompt);
    const parsed = extractJson<{
      reply?: string;
      shouldDraftIssue?: boolean;
      issue?: Partial<IssueSuggestionResult> | null;
    }>(result.response.text());

    const reply =
      typeof parsed.reply === 'string' && parsed.reply.trim()
        ? parsed.reply.trim()
        : 'Here is what I found.';

    if (parsed.shouldDraftIssue && parsed.issue) {
      const type = ISSUE_TYPES.includes(String(parsed.issue.type))
        ? String(parsed.issue.type)
        : 'bug';
      return {
        reply,
        shouldDraftIssue: true,
        issue: { ...fallbackIssue, ...parsed.issue, type },
      };
    }

    return { reply, shouldDraftIssue: false, issue: null };
  } catch (err) {
    console.error('generateAgentReply failed:', err);
    return {
      reply:
        "I had trouble processing that just now. Could you rephrase, or tell me what you'd like to do?",
      shouldDraftIssue: false,
      issue: null,
    };
  }
}

// ---------- Issue-scoped agent ----------

// Fields the issue agent is allowed to propose changing. Mirrors the editable
// columns on Issue that the PATCH /issues/:id endpoint accepts.
export interface IssueFieldPatch {
  title?: string;
  description?: string;
  type?: string;
  status?: 'open' | 'in_progress' | 'resolved';
  severity?: string | null;
  priority?: string | null;
  environment?: string | null;
  expectedResult?: string | null;
  actualResult?: string | null;
  stepsToReproduce?: string[];
  acceptanceCriteria?: string[];
}

export type IssueAction =
  | { kind: 'update_fields'; summary: string; fields: IssueFieldPatch }
  | { kind: 'post_comment'; summary: string; comment: string };

export interface IssueAgentReplyResult {
  reply: string;
  action: IssueAction | null;
}

const ALLOWED_PATCH_KEYS: (keyof IssueFieldPatch)[] = [
  'title',
  'description',
  'type',
  'status',
  'severity',
  'priority',
  'environment',
  'expectedResult',
  'actualResult',
  'stepsToReproduce',
  'acceptanceCriteria',
];

// Keep only recognized keys and coerce the two array fields, so a malformed
// model response can never smuggle arbitrary columns into the PATCH.
function sanitizeFieldPatch(raw: unknown): IssueFieldPatch {
  const out: IssueFieldPatch = {};
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const key of ALLOWED_PATCH_KEYS) {
    if (!(key in obj) || obj[key] === undefined) continue;
    const value = obj[key];
    if (key === 'stepsToReproduce' || key === 'acceptanceCriteria') {
      if (Array.isArray(value)) {
        out[key] = value.map((v) => String(v)).filter((v) => v.trim().length > 0);
      }
    } else if (key === 'type') {
      if (ISSUE_TYPES.includes(String(value))) out.type = String(value);
    } else if (key === 'status') {
      if (['open', 'in_progress', 'resolved'].includes(String(value))) {
        out.status = String(value) as IssueFieldPatch['status'];
      }
    } else if (key === 'severity') {
      if (value === null) out.severity = null;
      else if (SEVERITIES.includes(String(value))) out.severity = String(value);
    } else if (key === 'priority') {
      if (value === null) out.priority = null;
      else if (PRIORITIES.includes(String(value))) out.priority = String(value);
    } else {
      // scalar string fields: title, description, environment, expected/actual.
      // Only accept genuine strings or explicit null; never coerce objects/arrays,
      // and never blank the title.
      if (value === null) {
        // Only the nullable scalars may be cleared; ignore null for title/description.
        if (key === 'environment' || key === 'expectedResult' || key === 'actualResult') {
          out[key] = null;
        }
      } else if (typeof value === 'string') {
        if (key === 'title' && value.trim().length === 0) continue;
        out[key] = value;
      }
    }
  }
  return out;
}

function normalizeIssueAction(raw: unknown): IssueAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (obj.kind === 'post_comment') {
    const comment = typeof obj.comment === 'string' ? obj.comment.trim() : '';
    if (!comment) return null;
    return { kind: 'post_comment', summary: summary || 'Post this comment on the issue.', comment };
  }
  if (obj.kind === 'update_fields') {
    const fields = sanitizeFieldPatch(obj.fields);
    if (Object.keys(fields).length === 0) return null;
    return {
      kind: 'update_fields',
      summary: summary || 'Apply these field updates to the issue.',
      fields,
    };
  }
  return null;
}

// Conversational agent scoped to a SINGLE issue. It answers questions about the
// open issue and its discussion, and — only when the user asks to change the
// issue or add a comment — returns ONE proposed action the user confirms in the
// UI. It never drafts a separate new issue card.
export async function generateIssueAgentReply(input: {
  history: AgentTurn[];
  userMessage: string;
  projectContext: string;
  issueIntel: string;
}): Promise<IssueAgentReplyResult> {
  if (!genAI) {
    return {
      reply:
        'AI is not configured in this environment, so I can’t analyze this issue right now. Set GEMINI_API_KEY to enable the assistant.',
      action: null,
    };
  }

  const model = genAI.getGenerativeModel({ model: env.gemini.model });
  const historyText =
    input.history
      .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
      .join('\n') || '(no earlier messages)';

  const prompt = `You are Bugbot, an AI assistant embedded inside ONE specific issue of an issue tracker.
Your entire context is the single issue described under ISSUE DATA. Answer about THIS issue.

You can:
- Answer questions and summarize this issue and its discussion using ISSUE DATA.
- When the user asks you to improve/change the issue, propose ONE "update_fields" action with only the fields that should change (e.g. sharper stepsToReproduce, clearer description, tighter acceptanceCriteria, a corrected severity/status/priority/type).
- When the user asks you to add a comment / reply on the issue, propose ONE "post_comment" action.

Behaviour rules:
- ALWAYS write a helpful, conversational "reply" that addresses the user's latest message, using ISSUE DATA and the conversation so far.
- Propose an action ONLY when the user clearly wants to change the issue or post a comment. Otherwise set action=null and just answer in "reply".
- Never invent a brand-new separate issue; you only ever act on THIS issue.
- For update_fields, include ONLY the keys that change. For array fields (stepsToReproduce, acceptanceCriteria) return the FULL new list, not a diff.
- Keep "summary" a one-line plain-English description of what the action will do, since the user sees it on a confirm button.
- For issue "type", choose from: ${ISSUE_TYPES.join(', ')}. For "status", use: open, in_progress, resolved.

PROJECT CONTEXT:
${input.projectContext || 'none provided'}

ISSUE DATA:
${input.issueIntel}

CONVERSATION SO FAR:
${historyText}

NEW USER MESSAGE:
"""
${input.userMessage}
"""

Return ONLY a JSON object with this exact shape:
{
  "reply": string,
  "action": null | {
    "kind": "update_fields",
    "summary": string,
    "fields": {
      "title"?: string,
      "description"?: string,
      "type"?: string,
      "status"?: "open" | "in_progress" | "resolved",
      "severity"?: "low" | "medium" | "high" | "critical" | null,
      "priority"?: "low" | "medium" | "high" | "urgent" | null,
      "environment"?: string | null,
      "expectedResult"?: string | null,
      "actualResult"?: string | null,
      "stepsToReproduce"?: string[],
      "acceptanceCriteria"?: string[]
    }
  } | {
    "kind": "post_comment",
    "summary": string,
    "comment": string
  }
}`;

  try {
    const result = await model.generateContent(prompt);
    const parsed = extractJson<{ reply?: string; action?: unknown }>(result.response.text());
    const reply =
      typeof parsed.reply === 'string' && parsed.reply.trim()
        ? parsed.reply.trim()
        : 'Here is what I found.';
    return { reply, action: normalizeIssueAction(parsed.action) };
  } catch (err) {
    console.error('generateIssueAgentReply failed:', err);
    return {
      reply:
        "I had trouble analyzing this issue just now. Could you rephrase, or tell me what you'd like to do?",
      action: null,
    };
  }
}

export { isGeminiConfigured };
