# Work order: <short imperative title>

- Epic: #<epic> · LLD: #<lld> (`docs/projects/<epic>-<slug>/LLD-<module>.md`) · Milestone: <name>
- Branch: `feature/<this issue>-<slug>` from `origin/develop`
- Worktree: `../openoffice-worktrees/feature-<this issue>-<slug>`
- Session: `ieum-dev-<this issue>` (opened by ieum-developer with `tools/agent-team/start.sh --window worker <this issue>`)

## Goal

<One or two sentences: what works when this is done.>

## Scope

Files to change (no other files without asking ieum-developer first):

- `<path>` — <what to add or change>

Out of scope:

- <explicitly excluded work>

## Implementation steps

1. <step, referencing the LLD function by name>
2. <step>

## Unit tests

- `<workspace>/tests/<file>.test.ts` — <cases from LLD section 5>

## Acceptance criteria

- [ ] <observable result tied to SRS FR/NFR id>
- [ ] Workspace typecheck passes: `npm run typecheck -w @genoffice/<workspace>`
- [ ] Workspace tests pass: `npm run test -w @genoffice/<workspace>`
- [ ] `npx eslint` and `npx prettier --check` pass on changed files
- [ ] Dev report committed: `docs/projects/<epic>-<slug>/dev-report-<this issue>.md`

## Constraints

- Follow the absolute rules in `CLAUDE.md`. Do not touch document engine packages, subscription login files, or `@genoffice/*` / `GENOFFICE_*` names.
- Code comments in English. Commit messages in English Conventional Commits.
- Use Node 22 (`.nvmrc`).
- If the LLD cannot be implemented as written, stop and report to ieum-developer. Do not redesign on your own.
