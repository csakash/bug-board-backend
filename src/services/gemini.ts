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

export { isGeminiConfigured };
