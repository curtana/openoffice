import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { tempDir } from './helpers'

const SCRIPT = join(__dirname, '../../../tools/agent-hooks/guard.mjs')

let root: string
let fakeGh: string

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function writeFile(name: string, body: string): void {
  mkdirSync(join(root, name, '..'), { recursive: true })
  writeFileSync(join(root, name), body)
}

/** A fake `gh` that prints a fixed JSON reply for `issue view`. */
function ghReplies(reply: unknown): void {
  writeFileSync(join(root, 'gh-reply.json'), JSON.stringify(reply))
  writeFileSync(fakeGh, `#!/bin/sh\ncat "${join(root, 'gh-reply.json')}"\n`)
  chmodSync(fakeGh, 0o755)
}

function hook(input: Record<string, unknown>, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd: root, ...input }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      IEUM_TEAM: '',
      IEUM_HOOK_ROOT: root,
      IEUM_GH_BIN: fakeGh,
      IEUM_HOOK_NO_NOTIFY: '1',
      ...env,
    },
  })
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null
  return { code: r.status, out }
}

const bash = (team: string, command: string) =>
  hook({
    hook_event_name: 'PreToolUse',
    agent_type: team,
    tool_name: 'Bash',
    tool_input: { command },
  })
const write = (team: string, file_path: string) =>
  hook({
    hook_event_name: 'PreToolUse',
    agent_type: team,
    tool_name: 'Write',
    tool_input: { file_path },
  })
const denied = (r: ReturnType<typeof hook>) =>
  r.out?.hookSpecificOutput?.permissionDecision === 'deny'
    ? (r.out.hookSpecificOutput.permissionDecisionReason as string)
    : null

beforeEach(() => {
  root = tempDir()
  fakeGh = join(root, 'fake-gh')
  ghReplies({ labels: [], comments: [] })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  writeFile('README.md', 'x\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
})

describe('agent hook guard: who is guarded', () => {
  it('leaves a session that is not a team alone', () => {
    const r = hook({
      hook_event_name: 'PreToolUse',
      agent_type: 'Explore',
      tool_name: 'Bash',
      tool_input: { command: 'git tag v1' },
    })
    expect(r.out).toBeNull()
  })

  it('takes the team from IEUM_TEAM when agent_type is not a team', () => {
    const r = hook(
      {
        hook_event_name: 'PreToolUse',
        agent_type: 'Explore',
        tool_name: 'Bash',
        tool_input: { command: 'git tag v1' },
      },
      { IEUM_TEAM: 'ieum-developer' },
    )
    expect(denied(r)).toMatch(/Tags are created by a person/)
  })
})

describe('agent hook guard: rules for every team', () => {
  it.each([
    ['gh issue list', /Add --repo curtana\/openoffice/],
    ['gh pr create --repo pblsketch/openoffice', /upstream repository/],
    ['gh release create v1 --repo curtana/openoffice', /published by a person/],
    ['gh workflow run ci.yml --repo curtana/openoffice', /started by a person/],
    ['gh api graphql -f query=x', /must target repos\/curtana\/openoffice/],
    ['cat ~/.codex/auth.json', /login files/],
    ['ls ~/.genoffice', /~\/\.genoffice are off limits/],
    ['genoffice --version', /genoffice command/],
    ['git tag v1.0.0', /Tags are created by a person/],
    ['echo {} > .claude/agent-approvals.json', /Only a person writes/],
    ['node tools/agent-team/approve.mjs main-merge', /Only a person runs/],
    ['tools/agent-team/start.sh --window qa', /Only ieum-pm starts team sessions/],
  ])('denies %s', (command, reason) => {
    expect(denied(bash('ieum-developer', command))).toMatch(reason)
  })

  it.each([
    'gh issue list --repo curtana/openoffice --label status:qa',
    'gh api repos/curtana/openoffice/milestones -f title=M1',
    'npm run test -w @genoffice/cli',
    "gh issue comment 5 --repo curtana/openoffice --body-file - <<'EOF'\n[handoff] dev -> qa; gh pr create\nEOF",
  ])('allows %s', (command) => {
    expect(denied(bash('ieum-developer', command))).toBeNull()
  })

  it('lets the dev lead open a session per work order and PM start the teams', () => {
    expect(
      denied(
        bash('ieum-developer', 'tools/agent-team/start.sh --window worker 12 "Work order #12"'),
      ),
    ).toBeNull()
    expect(denied(bash('ieum-dev-worker', 'tools/agent-team/start.sh --window worker 13'))).toMatch(
      /Only the dev lead/,
    )
    expect(denied(bash('ieum-pm', 'tools/agent-team/start.sh --window release'))).toBeNull()
  })

  it('denies writing the approvals file with the Write tool', () => {
    expect(denied(write('ieum-pm', join(root, '.claude/agent-approvals.json')))).toMatch(
      /Only a person/,
    )
  })
})

describe('agent hook guard: QA changes nothing', () => {
  it.each([
    ['sed -i "" s/a/b/ apps/docs/src/x.ts', /in place/],
    ['echo hi > apps/docs/x.txt', /does not write files/],
    ['npx prettier --write x.md', /--write\/--fix/],
    ['git commit -m x', /does not run git commit/],
    ['git push origin feature/1-x', /does not run git push/],
    ['git switch -c qa-branch', /does not create branches|own detached worktree/],
    ['git worktree add ../openoffice-worktrees/qa-5 HEAD', /detached/],
  ])('denies %s', (command, reason) => {
    expect(denied(bash('ieum-qa', command))).toMatch(reason)
  })

  it.each([
    'git worktree add --detach ../openoffice-worktrees/qa-5 HEAD',
    'npm test 2>&1 | tail -5',
    'git diff main...HEAD > /tmp/qa.diff',
  ])('allows %s', (command) => {
    expect(denied(bash('ieum-qa', command))).toBeNull()
  })

  it('denies every file edit', () => {
    expect(denied(write('ieum-qa', join(root, 'docs/projects/1-x/HLD.md')))).toMatch(
      /never edits files/,
    )
  })
})

describe('agent hook guard: each team writes its own files', () => {
  it('PM writes only SRS documents', () => {
    expect(denied(write('ieum-pm', join(root, 'docs/projects/1-x/SRS.md')))).toBeNull()
    expect(denied(write('ieum-pm', join(root, 'apps/docs/src/a.ts')))).toMatch(/PM writes only/)
  })

  it('analysis/design writes only design documents and decisions', () => {
    expect(denied(write('ieum-designer', join(root, 'docs/projects/1-x/LLD-save.md')))).toBeNull()
    expect(
      denied(write('ieum-designer', join(root, 'docs/tracking/decisions/0045-x.md'))),
    ).toBeNull()
    expect(denied(write('ieum-designer', join(root, 'apps/docs/src/a.ts')))).toMatch(
      /Analysis\/design writes only/,
    )
  })

  it('the dev team does not edit SRS, HLD or LLD, and recognises worktree paths', () => {
    const wt = join(root, '..', 'openoffice-worktrees', 'feature-1-x')
    expect(denied(write('ieum-dev-worker', join(wt, 'docs/projects/1-x/LLD-save.md')))).toMatch(
      /belongs to PM or analysis/,
    )
    expect(
      denied(write('ieum-dev-worker', join(wt, 'docs/projects/1-x/dev-report-1.md'))),
    ).toBeNull()
    expect(denied(write('ieum-dev-worker', join(wt, 'apps/docs/src/a.ts')))).toBeNull()
  })

  it('engine packages need a recorded approval', () => {
    const file = join(root, 'packages/docx-engine/src/a.ts')
    expect(denied(write('ieum-dev-worker', file))).toMatch(/document engine package/)
    writeFile(
      '.claude/agent-approvals.json',
      JSON.stringify({ engine: [{ path: 'packages/docx-engine/', issue: 1 }] }),
    )
    expect(denied(write('ieum-dev-worker', file))).toBeNull()
  })
})

describe('agent hook guard: branches', () => {
  it('only PM commits on main, and only SRS', () => {
    writeFile('apps/docs/src/a.ts', 'x\n')
    git('add', '.')
    expect(denied(bash('ieum-developer', 'git commit -m x'))).toMatch(/Only PM commits on main/)
    expect(denied(bash('ieum-pm', 'git commit -m x'))).toMatch(/Commit blocked: PM writes only/)
    git('reset', '-q')
    writeFile('docs/projects/1-x/SRS.md', '# SRS\n')
    git('add', 'docs')
    expect(denied(bash('ieum-pm', 'git commit -m x'))).toBeNull()
  })

  it('a commit that touches an engine package is blocked', () => {
    git('switch', '-q', '-c', 'feature/1-x')
    writeFile('packages/pptx-ops/src/a.ts', 'x\n')
    git('add', '.')
    expect(denied(bash('ieum-dev-worker', 'git commit -m x'))).toMatch(
      /Commit blocked: .*document engine/,
    )
  })

  it('pushes go only where the team works', () => {
    expect(denied(bash('ieum-dev-worker', 'git push origin develop'))).toMatch(/push develop/)
    expect(denied(bash('ieum-dev-worker', 'git push -u origin feature/12-x'))).toBeNull()
    expect(denied(bash('ieum-designer', 'git push origin main'))).toMatch(/push main/)
    expect(denied(bash('ieum-developer', 'git push --force origin develop'))).toMatch(/force-push/)
    expect(denied(bash('ieum-pm', 'git push origin main'))).toBeNull()
  })

  it('a pull request into main is merged only by ieum-release for an approved head', () => {
    const merge = 'gh pr merge 2 --repo curtana/openoffice --merge'
    ghReplies({ baseRefName: 'main', headRefOid: 'abcdef1234567890' })
    expect(denied(bash('ieum-developer', merge))).toMatch(/Only ieum-release merges into main/)
    expect(denied(bash('ieum-release', merge))).toMatch(/approve\.mjs main-merge abcdef123456/)
    writeFile(
      '.claude/agent-approvals.json',
      JSON.stringify({ mainMerge: [{ commit: 'abcdef123456' }] }),
    )
    expect(denied(bash('ieum-release', merge))).toBeNull()
    expect(denied(bash('ieum-release', `${merge} --auto`))).toMatch(/Auto-merge/)
    expect(
      denied(bash('ieum-release', 'gh api -X PUT repos/curtana/openoffice/pulls/2/merge')),
    ).toMatch(/gh pr merge, not gh api/)
  })

  it('a pull request into develop is merged only by the dev lead', () => {
    ghReplies({ baseRefName: 'develop', headRefOid: 'abc' })
    const merge = 'gh pr merge 3 --repo curtana/openoffice --merge'
    expect(denied(bash('ieum-dev-worker', merge))).toMatch(/Only the dev lead merges into develop/)
    expect(denied(bash('ieum-developer', merge))).toBeNull()
  })

  it('a feature branch enters develop only with qa:approved', () => {
    git('switch', '-q', '-c', 'develop')
    git('branch', 'feature/7-split-save')
    ghReplies({ labels: [{ name: 'status:qa' }] })
    expect(denied(bash('ieum-developer', 'git merge --no-ff feature/7-split-save'))).toMatch(
      /#7 has no qa:approved/,
    )
    ghReplies({ labels: [{ name: 'qa:approved' }] })
    expect(denied(bash('ieum-developer', 'git merge --no-ff feature/7-split-save'))).toBeNull()
    expect(denied(bash('ieum-dev-worker', 'git merge --no-ff feature/7-split-save'))).toMatch(
      /Only the dev lead/,
    )
  })

  it('develop enters main only through ieum-release with the user approval for that commit', () => {
    git('branch', 'develop')
    const sha = git('rev-parse', 'develop')
    expect(denied(bash('ieum-developer', 'git merge develop'))).toMatch(
      /Only ieum-release merges into main/,
    )
    expect(denied(bash('ieum-release', 'git merge --no-ff develop'))).toMatch(
      /needs the user's approval/,
    )
    writeFile(
      '.claude/agent-approvals.json',
      JSON.stringify({ mainMerge: [{ commit: sha.slice(0, 12) }] }),
    )
    expect(denied(bash('ieum-release', 'git merge --no-ff develop'))).toBeNull()
  })

  it('release branches need the version approved', () => {
    const add = (v: string) =>
      `git worktree add ../openoffice-worktrees/release-${v} -b release/${v} origin/main`
    expect(denied(bash('ieum-developer', add('0.13.0')))).toMatch(/Only ieum-release/)
    expect(denied(bash('ieum-release', add('0.13.0')))).toMatch(/needs the user's approval/)
    writeFile('.claude/agent-approvals.json', JSON.stringify({ release: [{ version: '0.13.0' }] }))
    expect(denied(bash('ieum-release', add('0.13.0')))).toBeNull()
  })

  it('keeps the root checkout on main', () => {
    expect(denied(bash('ieum-designer', 'git switch develop'))).toMatch(
      /root checkout stays on main/,
    )
    expect(denied(bash('ieum-designer', 'git switch -c design/3-x origin/develop'))).toMatch(
      /root checkout stays on main/,
    )
    expect(denied(bash('ieum-release', 'git switch main'))).toBeNull()
    expect(denied(bash('ieum-developer', 'git checkout -- README.md'))).toBeNull()
    expect(
      denied(
        bash(
          'ieum-designer',
          'git worktree add ../openoffice-worktrees/design-3-x -b design/3-x origin/develop',
        ),
      ),
    ).toBeNull()
  })
})

describe('agent hook guard: notices', () => {
  const after = (team: string, command: string) =>
    hook({
      hook_event_name: 'PostToolUse',
      agent_type: team,
      tool_name: 'Bash',
      tool_input: { command },
    })

  it('asks for an escalation when one finding reaches its third QA round', () => {
    const round = (n: number) => ({ body: `QA round ${n}\n- QA-7-1 still fails` })
    ghReplies({ labels: [], comments: [round(1), round(2)] })
    expect(after('ieum-qa', 'gh issue comment 7 --repo curtana/openoffice --body x').out).toBeNull()
    ghReplies({ labels: [], comments: [round(1), round(2), round(3)] })
    const r = after('ieum-qa', 'gh issue comment 7 --repo curtana/openoffice --body x')
    expect(r.out.hookSpecificOutput.additionalContext).toMatch(
      /QA-7-1 came up in 3 or more QA rounds.*ieum-pm/,
    )
  })

  it('stays quiet once the issue is escalated', () => {
    const round = (n: number) => ({ body: `QA round ${n}\n- QA-7-1` })
    ghReplies({ labels: [{ name: 'escalation' }], comments: [round(1), round(2), round(3)] })
    expect(after('ieum-qa', 'gh issue comment 7 --repo curtana/openoffice --body x').out).toBeNull()
  })

  it('points PM at the user when needs-user is added', () => {
    const r = after('ieum-pm', 'gh issue edit 4 --repo curtana/openoffice --add-label needs-user')
    expect(r.out.hookSpecificOutput.additionalContext).toMatch(
      /needs-user on #4.*SendMessage to "main"/,
    )
  })
})

describe('agent hook guard: handoff before stopping', () => {
  function transcript(commands: string[]): string {
    const lines = [
      { type: 'user', message: { content: 'do the work' } },
      ...commands.map((command) => ({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
      })),
    ]
    const path = join(root, 'transcript.jsonl')
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'))
    return path
  }
  const stop = (path: string, active = false) =>
    hook({
      hook_event_name: 'Stop',
      agent_type: 'ieum-developer',
      transcript_path: path,
      stop_hook_active: active,
    })

  it('blocks a stop after a push with no [handoff] comment', () => {
    expect(stop(transcript(['git push -u origin feature/1-x'])).out).toMatchObject({
      decision: 'block',
    })
  })

  it('lets it stop once a handoff was posted, or when nothing changed', () => {
    expect(
      stop(
        transcript([
          'git push',
          "gh issue comment 1 --repo curtana/openoffice --body '[handoff] dev -> qa'",
        ]),
      ).out,
    ).toBeNull()
    expect(stop(transcript(['git status'])).out).toBeNull()
  })

  it('does not block twice in a row', () => {
    expect(stop(transcript(['git push']), true).out).toBeNull()
  })
})
