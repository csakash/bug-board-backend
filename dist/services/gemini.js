import { GoogleGenerativeAI } from '@google/generative-ai';
import { env, isGeminiConfigured } from '../config/env.js';
const genAI = isGeminiConfigured ? new GoogleGenerativeAI(env.gemini.apiKey) : null;
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
function extractJson(text) {
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
    return JSON.parse(cleaned.slice(start, end + 1));
}
export async function generateProjectContext(input) {
    const fallback = {
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
    if (!genAI)
        return fallback;
    const model = genAI.getGenerativeModel({ model: env.gemini.model });
    const prompt = `You are an assistant that builds a reusable project context profile for an issue tracker.
The tracker handles ALL product work: bugs, features, improvements, tasks, regressions, investigations, design, documentation, support, and questions.

Project name: ${input.name}
Project description: ${input.description}
Attached resources:
${input.fileSummaries.map((s) => `- ${s}`).join('\n') || '- none'}
Links:
${input.links.map((l) => `- ${l}`).join('\n') || '- none'}

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
        const result = await model.generateContent(prompt);
        const parsed = extractJson(result.response.text());
        return { ...fallback, ...parsed };
    }
    catch (err) {
        console.error('generateProjectContext failed:', err);
        return fallback;
    }
}
export async function generateIssueSuggestion(input) {
    const fallback = {
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
    if (!genAI)
        return fallback;
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
        const parsed = extractJson(result.response.text());
        const type = ISSUE_TYPES.includes(String(parsed.type)) ? String(parsed.type) : 'bug';
        return { ...fallback, ...parsed, type };
    }
    catch (err) {
        console.error('generateIssueSuggestion failed:', err);
        return fallback;
    }
}
// Conversational agent that has the full thread history plus live project data.
// It replies naturally and only drafts a structured issue card when the user is
// actually reporting a problem or requesting trackable work.
export async function generateAgentReply(input) {
    const fallbackIssue = {
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
            reply: 'AI is not configured in this environment, so I drafted a basic card from your message. Review and edit it before adding it to the board.',
            shouldDraftIssue: true,
            issue: fallbackIssue,
        };
    }
    const model = genAI.getGenerativeModel({ model: env.gemini.model });
    const historyText = input.history
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
        const parsed = extractJson(result.response.text());
        const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
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
    }
    catch (err) {
        console.error('generateAgentReply failed:', err);
        return {
            reply: "I had trouble processing that just now. Could you rephrase, or tell me what you'd like to do?",
            shouldDraftIssue: false,
            issue: null,
        };
    }
}
export { isGeminiConfigured };
//# sourceMappingURL=gemini.js.map