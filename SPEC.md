# SPEC: Issue-scoped Bug AI sidebar (read + write actions)

## Context

The Bug AI chat is **project-scoped**. `ChatThread` carried only `projectId` + `userId`
(`backend/prisma/schema.prisma`), the `ChatDrawer` mounted only on the board
(`frontend/src/pages/BoardPage.tsx:157`), and the agent's context was
`buildProjectIntel(projectId)` — project-wide counts and recent issues. Its job was
"answer project questions + draft a NEW issue card" (`backend/src/services/gemini.ts`).

The individual issue view (`frontend/src/pages/IssueDetailPage.tsx`) had **no assistant**.
A user reading a single issue could not ask the AI about that issue with it as active context.

This adds an issue-scoped assistant: open an issue → a Bug AI drawer whose live context is
that issue (its fields, its comments, and related issues). The user chats about the open
issue, and the agent can **propose confirm-gated write actions** on it.

## Scope (v1 — read + write, locked)

- **Read context fed to the agent:** the open issue's own fields (title, type, status,
  severity, priority, environment, description, steps, expected/actual, acceptance criteria,
  labels, reporter/assignee) + **its comment thread** + **related issues** + project context
  (`formatProjectContext`). Built by `buildIssueIntel(issueId)`.
- **Write actions (confirm-gated):** the agent may return ONE proposed action per reply:
  - `update_fields` — a partial patch (title/description/type/status/severity/priority/
    environment/expected/actual/stepsToReproduce/acceptanceCriteria). Applied via the
    existing `PATCH /api/issues/:issueId` (schema extended to accept the structured fields).
  - `post_comment` — post the agent's text as a comment via existing
    `POST /api/issues/:issueId/comments`.
  Nothing is written until the user clicks **Apply changes** / **Post comment**. The drawer
  invalidates `['issue', issueId]` + `['issues', projectId]` so the page updates immediately.
- **Persistence:** per-issue chat threads, saved and revisitable, never mixed with board threads.
- **UI:** reuse the board's slide-in, resizable Bug AI drawer, plus a confirm-gated action card.

## Out of scope

- The agent drafting a brand-new / separate issue card (that stays board-only).
- Auto-applying changes without user confirmation.
- Streaming responses (keeps existing request/response shape).
- Editing the proposed action inline before applying (dismiss + re-ask instead) — later add.

## Data model

Nullable `issueId` on `ChatThread` (board threads keep `issueId = null`; issue threads set
it). `projectId` stays required. Applied with `npm run db:push` (nullable column + index,
non-destructive).

```prisma
model ChatThread {
  // ...existing...
  issueId String?
  issue   Issue?  @relation(fields: [issueId], references: [id], onDelete: Cascade)
  @@index([issueId, userId, updatedAt])
}
model Issue { chatThreads ChatThread[] }
```

## API

New (issue-scoped, mirror the project endpoints):
- `GET  /api/issues/:issueId/chat/threads` — list the user's threads for this issue; ensure one exists.
- `POST /api/issues/:issueId/chat/threads` — start a fresh issue thread.

Reused / branched:
- `GET  /api/chat/threads/:threadId/messages` — unchanged (thread-scoped, ownership-checked).
- `POST /api/chat/threads/:threadId/messages` — **branches on `thread.issueId`**: if set, runs
  `generateIssueAgentReply` (issue intel; `suggestion: null`, `action` may be set); else the
  existing project agent (`action: null`). Response: `{ threadId, message, suggestion, action, title }`.
- `PATCH /api/issues/:issueId` — schema extended with `environment`, `expectedResult`,
  `actualResult`, `stepsToReproduce[]`, `acceptanceCriteria[]` so field-edit actions apply.
- `POST /api/issues/:issueId/comments` — reused as-is for `post_comment`.

Board thread queries now filter `issueId: null` so board and issue threads never mix.

## Acceptance criteria

1. Opening any issue shows a Bug AI drawer (slide-in, resizable), toggleable by a button.
2. Sending a message returns an answer grounded in that issue's fields, comments, and related issues.
3. "Improve the acceptance criteria" (or repro steps / description / severity) returns a
   `update_fields` proposal; clicking **Apply changes** persists it and the page reflects it.
4. "Draft a comment summarizing status" returns a `post_comment` proposal; **Post comment**
   adds it to the issue's Activity.
5. No change is written until the user confirms; **Dismiss** discards the proposal.
6. Issue chat threads persist across reloads; the history switcher lists that issue's threads only.
7. Issue threads never mix with board chat threads, and vice versa.
8. The issue agent never emits a "draft new issue" card.
9. Board chat is unchanged in behavior.
10. `npm run build` clean in both `backend/` and `frontend/`. ✓

## Files

| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | `issueId` on `ChatThread` (relation + index); `chatThreads` on `Issue` |
| `backend/src/services/project-intel.ts` | add `buildIssueIntel(issueId)` (fields + comments + related) |
| `backend/src/services/gemini.ts` | add `generateIssueAgentReply()` + `IssueAction` types + sanitizers |
| `backend/src/routes/chat.ts` | issue thread list/create; branch messages on `issueId`; scope board threads to `issueId: null` |
| `backend/src/routes/issues.ts` | extend `patchSchema` with structured fields |
| `frontend/src/types.ts` | `IssueFieldPatch`, `IssueChatAction` |
| `frontend/src/components/ChatDrawer.tsx` | `issueId` prop; issue endpoints/greeting; `ActionCard` + apply/dismiss |
| `frontend/src/pages/IssueDetailPage.tsx` | flex layout wrap, mount drawer, toggle button |

## Rollback

Revert the diff in both repos. The `issueId` column is nullable and additive; board threads
and existing data are untouched, so no data migration to undo.
