#!/usr/bin/env node
/**
 * Hook guard for the agent team process (docs/process/agent-workflow.md).
 *
 * Registered in .claude/settings.json for PreToolUse, PostToolUse, Stop and
 * SubagentStop. It reads the hook input JSON on stdin and works out which
 * team is acting: `agent_type` when it names an `ieum-*` agent, otherwise the
 * IEUM_TEAM variable that tools/agent-team/start.sh exports. A session with
 * neither (a person's own session) gets no rules at all.
 *
 *   PreToolUse   denies what a team may not do: a `gh` call that is not
 *                pinned to this fork, subscription login files, the upstream
 *                app's registrations, tags and releases, edits outside the
 *                team's files, document engine changes without approval,
 *                merges without a QA approval or a user approval.
 *   PostToolUse  notices: the third QA round on one finding, the third design
 *                change on one issue, and `needs-user` / `escalation` labels.
 *   Stop         asks a team that committed, pushed or opened a PR in this
 *                turn to leave a `[handoff]` issue comment before it stops.
 *
 * Approvals that only a person may give live in .claude/agent-approvals.json
 * (local, not committed). Teams can read it but not write it.
 *
 * Every denial and notice is appended to .claude/agent-log.jsonl.
 *
 * Testing hooks: IEUM_GH_BIN replaces the `gh` binary, IEUM_HOOK_ROOT the
 * repository root, IEUM_HOOK_NO_NOTIFY=1 turns desktop notifications off.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.IEUM_HOOK_ROOT ?? resolve(HERE, '../..')
const POLICY = JSON.parse(readFileSync(join(HERE, 'policy.json'), 'utf8'))
const APPROVALS_FILE = join(ROOT, '.claude', 'agent-approvals.json')
const LOG_FILE = join(ROOT, '.claude', 'agent-log.jsonl')
const GH = process.env.IEUM_GH_BIN ?? 'gh'

const TEAMS = new Set([
  'ieum-pm',
  'ieum-designer',
  'ieum-developer',
  'ieum-dev-worker',
  'ieum-qa',
  'ieum-release',
])

// ---------------------------------------------------------------------------
// Shell parsing: just enough to split a command line into simple commands,
// their words, redirection targets and the directory each one runs in.

/** Split a command line into segments at unquoted ; && || | and newlines, skipping heredoc bodies. */
export function splitCommands(line) {
  const segments = []
  let cur = ''
  let quote = null
  const pendingHeredocs = []
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else if (c === quote) quote = null
      continue
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += c + line[++i]
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line.slice(i))
      if (m) {
        pendingHeredocs.push(m[2])
        cur += m[0]
        i += m[0].length - 1
        continue
      }
    }
    if (c === '\n') {
      segments.push(cur)
      cur = ''
      // drop heredoc bodies: they are data, not commands
      while (pendingHeredocs.length > 0) {
        const tag = pendingHeredocs.shift()
        const rest = line.slice(i + 1)
        const lines = rest.split('\n')
        let consumed = 0
        let k = 0
        for (; k < lines.length; k++) {
          consumed += lines[k].length + 1
          if (lines[k].trim() === tag) break
        }
        i += consumed
      }
      continue
    }
    if (c === ';' || (c === '&' && line[i + 1] === '&') || c === '|') {
      if (c === '&' || (c === '|' && line[i + 1] === '|')) i++
      segments.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  segments.push(cur)
  return segments.map((s) => s.trim()).filter(Boolean)
}

/** Words and redirection targets of one simple command, quotes removed. */
export function parseWords(segment) {
  const words = []
  const redirects = []
  let cur = ''
  let has = false
  let quote = null
  let redirectNext = false
  const push = () => {
    if (!has) return
    if (redirectNext) redirects.push(cur)
    else words.push(cur)
    redirectNext = false
    cur = ''
    has = false
  }
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < segment.length) cur += segment[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      has = true
      continue
    }
    if (c === '\\' && i + 1 < segment.length) {
      cur += segment[++i]
      has = true
      continue
    }
    if (/\s/.test(c)) {
      push()
      continue
    }
    if (c === '>' || (c === '&' && segment[i + 1] === '>')) {
      // a fd prefix such as `2` belongs to the operator, not to the words
      if (has && /^\d+$/.test(cur)) {
        cur = ''
        has = false
      } else push()
      if (c === '&') i++
      if (segment[i + 1] === '>') i++
      if (segment[i + 1] === '&') {
        // >&2 or 2>&1: a descriptor, not a file
        i++
        while (i + 1 < segment.length && /[\d-]/.test(segment[i + 1])) i++
        continue
      }
      redirectNext = true
      continue
    }
    if (c === '<') {
      push()
      if (segment[i + 1] === '<') {
        // heredoc marker: skip the tag word
        i++
        if (segment[i + 1] === '-') i++
        while (i + 1 < segment.length && /\s/.test(segment[i + 1])) i++
        while (i + 1 < segment.length && !/\s/.test(segment[i + 1])) i++
      }
      continue
    }
    cur += c
    has = true
  }
  push()
  return { words, redirects }
}

/** Simple commands of a Bash call, each with the directory it runs in. */
export function analyzeCommand(command, cwd) {
  let dir = cwd
  const out = []
  for (const raw of splitCommands(command)) {
    const { words, redirects } = parseWords(raw)
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift()
    if (words[0] === 'env') words.shift()
    if (words.length === 0) continue
    if (words[0] === 'cd' && words[1]) {
      dir = expandHome(words[1], dir)
      continue
    }
    out.push({ raw, words, redirects, dir })
  }
  return out
}

function expandHome(p, base) {
  const home = process.env.HOME ?? ''
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return isAbsolute(p) ? p : resolve(base ?? process.cwd(), p)
}

/** `git` call details: the directory (-C), the subcommand and its arguments. */
export function gitCall(cmd) {
  if (cmd.words[0] !== 'git') return null
  let dir = cmd.dir
  let i = 1
  while (i < cmd.words.length && cmd.words[i].startsWith('-')) {
    if (cmd.words[i] === '-C') {
      dir = expandHome(cmd.words[i + 1], dir)
      i += 2
    } else if (cmd.words[i] === '-c') i += 2
    else i++
  }
  return { dir, sub: cmd.words[i], args: cmd.words.slice(i + 1) }
}

// ---------------------------------------------------------------------------
// Git and GitHub lookups. Each failure is reported, never silently allowed.

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function currentBranch(dir) {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
}

function stagedFiles(dir, all) {
  const files = git(dir, ['diff', '--cached', '--name-only']).split('\n')
  if (all) files.push(...git(dir, ['diff', '--name-only']).split('\n'))
  return [...new Set(files.filter(Boolean))]
}

function ghJson(args) {
  const out = execFileSync(GH, [...args, '--repo', POLICY.repo], {
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return JSON.parse(out)
}

function issueLabels(issue) {
  return ghJson(['issue', 'view', String(issue), '--json', 'labels']).labels.map((l) => l.name)
}

function readApprovals() {
  if (!existsSync(APPROVALS_FILE)) return {}
  try {
    return JSON.parse(readFileSync(APPROVALS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Rules

const isEnginePath = (p) => POLICY.enginePaths.some((e) => toRepoPath(p).startsWith(e))

/** Path relative to the repository or to whichever worktree holds it. */
function toRepoPath(p) {
  const abs = isAbsolute(p) ? p : resolve(ROOT, p)
  const rel = relative(ROOT, abs)
  if (!rel.startsWith('..')) return rel.split('\\').join('/')
  // a team worktree next to the repository: ../openoffice-worktrees/<name>/<path>
  const m = /openoffice-worktrees[\\/][^\\/]+[\\/](.*)$/.exec(abs)
  return m ? m[1].split('\\').join('/') : abs.split('\\').join('/')
}

function approvedEngine(path) {
  const rel = toRepoPath(path)
  return (readApprovals().engine ?? []).some((a) => a.path && rel.startsWith(a.path))
}

const SRS_PATH = /^docs\/projects\/[^/]+\/SRS\.md$/
const DESIGN_DOC = /^docs\/projects\/[^/]+\/(HLD|LLD-[^/]+)\.md$/
const DESIGNER_PATHS = [/^docs\/projects\//, /^docs\/tracking\/decisions\//]
const SECRET_PATTERNS = [
  /\.codex[\\/]auth\.json/,
  /\.claude[\\/]\.credentials/,
  /Claude Safe Storage/i,
  /security\s+(find|dump)-(generic|internet)-password/,
]
const UPSTREAM_HOME = /(^|[\s'"=:])(~|\$HOME|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.genoffice\b/

/** File writes a team may make, by repository-relative path. */
function writeRule(team, path) {
  const rel = toRepoPath(path)
  if (rel === '.claude/agent-approvals.json' || rel.endsWith('/.claude/agent-approvals.json'))
    return 'Only a person writes .claude/agent-approvals.json. Ask ieum-pm to get the approval from the user.'
  if (team === 'ieum-qa') return 'QA never edits files. Report findings as issue comments.'
  if (team === 'ieum-pm' && !SRS_PATH.test(rel))
    return `PM writes only docs/projects/<epic>-<slug>/SRS.md, not ${rel}.`
  if (team === 'ieum-designer' && !DESIGNER_PATHS.some((r) => r.test(rel)))
    return `Analysis/design writes only docs/projects/ and docs/tracking/decisions/, not ${rel}. Code belongs to the dev team.`
  if (
    (team === 'ieum-developer' || team === 'ieum-dev-worker') &&
    (SRS_PATH.test(rel) || DESIGN_DOC.test(rel))
  )
    return `${rel} belongs to PM or analysis/design. Ask for the change with a design-change comment.`
  if (isEnginePath(rel) && !approvedEngine(rel))
    return `${rel} is in a document engine package. Engine changes need the user's approval recorded in .claude/agent-approvals.json; send the request to ieum-pm.`
  return null
}

function denyGh(cmd) {
  const w = cmd.words
  if (w[0] !== 'gh') return null
  const sub = w[1]
  if (
    !sub ||
    ['auth', 'help', 'version', '--version', 'config', 'alias', 'completion'].includes(sub)
  )
    return null
  const text = w.join(' ')
  for (const up of POLICY.upstreamRepos)
    if (text.includes(up)) return `Never touch the upstream repository ${up}.`
  if (sub === 'release')
    return 'GitHub releases are published by a person (.claude/skills/release-ieumoffice).'
  if (sub === 'workflow' && w[2] === 'run') return 'Workflow runs are started by a person.'
  if (sub === 'repo' && !['view', 'clone'].includes(w[2]))
    return 'Repository settings are changed by a person.'
  if (sub === 'api') {
    const path = w.slice(2).find((x) => !x.startsWith('-') && /repos\//.test(x))
    if (!path || !path.replace(/^\//, '').startsWith(`repos/${POLICY.repo}/`))
      return `gh api calls must target repos/${POLICY.repo}/.`
    if (
      /\/(releases|actions\/workflows\/[^/]+\/dispatches)\b/.test(path) &&
      w.some((x) => /^(-X|--method)$/.test(x))
    )
      return "Releases and workflow runs are a person's job."
    return null
  }
  const pinned =
    w.some((x, i) => (x === '--repo' || x === '-R') && w[i + 1] === POLICY.repo) ||
    w.includes(`--repo=${POLICY.repo}`)
  if (!pinned)
    return `Add --repo ${POLICY.repo} to every gh command: this is a fork and gh may otherwise pick the upstream repository.`
  return null
}

function pushTargets(g, dir) {
  const args = g.args.filter((a) => !a.startsWith('-'))
  const force = g.args.some(
    (a) => /^(-f|--force|--force-with-lease.*|--mirror)$/.test(a) || /^\+/.test(a),
  )
  const del = g.args.includes('--delete') || g.args.includes('-d')
  const refspecs = args.slice(1)
  let targets
  if (refspecs.length === 0) targets = [currentBranch(dir)]
  else
    targets = refspecs.map((r) => {
      const dst = r.includes(':') ? r.split(':')[1] || r.split(':')[0] : r
      const name = dst.replace(/^\+/, '').replace(/^refs\/heads\//, '')
      return name === 'HEAD' ? currentBranch(dir) : name
    })
  return { targets, force, del: del || refspecs.some((r) => r.startsWith(':')) }
}

const NEW_BRANCH_FLAGS = new Set(['-b', '-B', '-c', '-C', '--orphan'])

function createdBranch(g) {
  if (g.sub === 'checkout' || g.sub === 'switch') {
    const i = g.args.findIndex((a) => NEW_BRANCH_FLAGS.has(a))
    return i >= 0 ? g.args[i + 1] : null
  }
  if (g.sub === 'branch') {
    if (g.args.some((a) => /^-(d|D|m|M|-delete|-move|l|-list|a|r|-show-current|v|vv)$/.test(a)))
      return null
    return g.args.find((a) => !a.startsWith('-')) ?? null
  }
  if (g.sub === 'worktree' && g.args[0] === 'add') {
    const i = g.args.findIndex((a) => a === '-b' || a === '-B')
    return i >= 0 ? g.args[i + 1] : null
  }
  return null
}

const QA_GIT_ALLOWED = new Set([
  'status',
  'log',
  'diff',
  'show',
  'fetch',
  'rev-parse',
  'ls-files',
  'ls-remote',
  'branch',
  'blame',
  'grep',
  'describe',
  'cat-file',
  'merge-base',
  'shortlog',
  'config',
  'remote',
  'worktree',
  'checkout',
  'switch',
])

function qaGitRule(g) {
  if (!QA_GIT_ALLOWED.has(g.sub))
    return `QA does not run git ${g.sub}. QA reads; it never changes branches or history.`
  if (g.sub === 'branch' && createdBranch(g)) return 'QA does not create branches.'
  if (g.sub === 'branch' && g.args.some((a) => /^-(d|D|m|M)$/.test(a)))
    return 'QA does not delete or rename branches.'
  if (g.sub === 'config' && !g.args.some((a) => a === '--get' || a === '--list' || a === '-l'))
    return 'QA does not change git config.'
  if (g.sub === 'remote' && g.args.length > 0 && !['-v', 'show', 'get-url'].includes(g.args[0]))
    return 'QA does not change remotes.'
  if (g.sub === 'worktree' && g.args[0] === 'add' && !g.args.includes('--detach'))
    return 'QA worktrees are detached: git worktree add --detach ../openoffice-worktrees/qa-<issue> <commit>.'
  if (
    (g.sub === 'checkout' || g.sub === 'switch') &&
    (createdBranch(g) || !g.dir?.includes('openoffice-worktrees'))
  )
    return 'QA checks out commits only inside its own detached worktree under ../openoffice-worktrees/.'
  return null
}

const TEMP_DIR =
  /^(\/dev\/null|\/dev\/std(out|err)|\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)/

/** A scratch location QA may write to: a temp directory outside the repository and its worktrees. */
function isScratch(abs) {
  if (!TEMP_DIR.test(abs)) return false
  if (abs.startsWith('/dev/')) return true
  return relative(ROOT, abs).startsWith('..') && !/openoffice-worktrees[\\/]/.test(abs)
}

function qaShellRule(cmd) {
  const w = cmd.words
  for (const r of cmd.redirects)
    if (!isScratch(expandHome(r, cmd.dir)))
      return `QA does not write files (redirect to ${r}). Use a temp directory.`
  if (
    w[0] === 'tee' &&
    w.slice(1).some((a) => !a.startsWith('-') && !isScratch(expandHome(a, cmd.dir)))
  )
    return 'QA does not write files with tee.'
  if (
    (w[0] === 'sed' || w[0] === 'perl') &&
    w.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))
  )
    return 'QA does not edit files in place.'
  if (['mv', 'cp', 'rm', 'touch', 'truncate', 'install', 'ln', 'chmod'].includes(w[0])) {
    const paths = w.slice(1).filter((a) => !a.startsWith('-'))
    if (paths.some((p) => !isScratch(expandHome(p, cmd.dir))))
      return `QA does not run ${w[0]} on repository files.`
  }
  if (w.some((a) => a === '--write' || a === '--fix' || (a === '-w' && w.includes('prettier'))))
    return 'QA does not rewrite files (--write/--fix).'
  if (
    /^(npm|npx)$/.test(w[0]) &&
    ['install', 'i', 'uninstall', 'update', 'version', 'publish', 'link'].includes(w[1])
  )
    return `QA does not run npm ${w[1]}; npm ci inside the QA worktree is fine.`
  return null
}

function engineInCommand(cmd) {
  const text = cmd.raw
  const writes =
    cmd.redirects.length > 0 ||
    ['sed', 'perl', 'mv', 'cp', 'rm', 'tee', 'touch', 'truncate', 'patch'].includes(cmd.words[0]) ||
    (cmd.words[0] === 'git' &&
      ['apply', 'am', 'checkout', 'restore', 'rm', 'mv'].includes(gitCall(cmd)?.sub))
  if (!writes) return null
  for (const e of POLICY.enginePaths) if (text.includes(e) && !approvedEngine(e)) return e
  return null
}

/** The main reason a Bash call must not run, or null. */
export function denyBash(team, command, cwd) {
  const cmds = analyzeCommand(command, cwd)
  for (const cmd of cmds) {
    const text = cmd.raw
    for (const re of SECRET_PATTERNS)
      if (re.test(text))
        return 'Subscription login files and stores are off limits (CLAUDE.md rule 1).'
    if (UPSTREAM_HOME.test(text) || cmd.words[0] === 'genoffice')
      return "The upstream app's genoffice command and ~/.genoffice are off limits (CLAUDE.md rule 5)."
    if (
      text.includes('agent-approvals.json') &&
      !['cat', 'jq', 'head', 'less', 'grep'].includes(cmd.words[0])
    )
      return 'Only a person writes .claude/agent-approvals.json.'
    if (/agent-team[\\/]approve/.test(text))
      return 'Only a person runs tools/agent-team/approve.mjs. Ask the user to run it.'
    if (/agent-team[\\/]start\.sh/.test(text)) {
      const worker = cmd.words.includes('worker')
      if (worker && team !== 'ieum-developer')
        return 'Only the dev lead opens work order sessions (start.sh worker <issue>).'
      if (!worker && team !== 'ieum-pm')
        return 'Only ieum-pm starts team sessions; ieum-release only when PM calls it.'
    }
    if (/ieumoffice-site/.test(text) && /\b(push|commit)\b/.test(text))
      return 'The site repository is published by a person (releasing.ko.md 13).'
    const gh = denyGh(cmd)
    if (gh) return gh
    if (team === 'ieum-qa') {
      const shell = qaShellRule(cmd)
      if (shell) return shell
    }
    const engine = engineInCommand(cmd)
    if (engine && team !== 'ieum-qa')
      return `${engine} is a document engine package. Engine changes need the user's approval in .claude/agent-approvals.json; send the request to ieum-pm.`

    const g = gitCall(cmd)
    if (!g) continue
    if (g.sub === 'tag') return 'Tags are created by a person when the release is published.'
    if (team === 'ieum-qa') {
      const r = qaGitRule(g)
      if (r) return r
      continue
    }
    // every team session reads hooks and agents from the root checkout, so it stays on main
    const inRoot = resolve(g.dir ?? ROOT) === resolve(ROOT)
    if (inRoot && (g.sub === 'switch' || (g.sub === 'checkout' && !g.args.includes('--')))) {
      const target = g.args.filter((a) => !a.startsWith('-')).pop()
      if (createdBranch(g) || (target && target !== 'main'))
        return 'The root checkout stays on main (all sessions read hooks and agents from it). Work in a worktree under ../openoffice-worktrees/.'
    }
    const created = createdBranch(g)
    if (created?.startsWith('release/')) {
      if (team !== 'ieum-release')
        return 'Only ieum-release creates release/* branches, when ieum-pm asks.'
      const version = created.slice('release/'.length)
      if (!(readApprovals().release ?? []).some((a) => a.version === version))
        return `release/${version} needs the user's approval in .claude/agent-approvals.json ({"release":[{"version":"${version}"}]}). Ask ieum-pm.`
    }
    if (created && team === 'ieum-dev-worker' && !created.startsWith('feature/'))
      return 'Dev team members work only on feature/<issue>-<slug> branches.'
    if (created && team === 'ieum-designer' && !created.startsWith('design/'))
      return 'Analysis/design works on design/<epic>-<slug> branches.'

    if (g.sub === 'push') {
      const { targets, force, del } = pushTargets(g, g.dir)
      for (const t of targets) {
        const isProtected = POLICY.protectedBranches.includes(t)
        if (isProtected && (force || del)) return `Never force-push or delete ${t}.`
        if (t === 'main' && !['ieum-pm', 'ieum-release'].includes(team))
          return 'Only ieum-pm (SRS) and ieum-release push main.'
        if (t === 'develop' && !['ieum-developer', 'ieum-designer', 'ieum-release'].includes(team))
          return 'Only the dev lead and analysis/design push develop.'
        if (t.startsWith('release/') && team !== 'ieum-release')
          return 'Only ieum-release pushes release/* branches.'
        if (team === 'ieum-dev-worker' && !t.startsWith('feature/'))
          return 'Dev team members push only their feature/* branch.'
      }
    }

    if (g.sub === 'commit') {
      const branch = currentBranch(g.dir)
      const files = stagedFiles(
        g.dir,
        g.args.some((a) => a === '-a' || a === '--all' || /^-[a-zA-Z]*a/.test(a)),
      )
      if (branch === 'main' && team !== 'ieum-pm')
        return 'Only PM commits on main, and only SRS documents.'
      for (const f of files) {
        const r = writeRule(team, f)
        if (r) return `Commit blocked: ${r}`
      }
    }

    if (g.sub === 'merge' || g.sub === 'rebase' || g.sub === 'cherry-pick' || g.sub === 'pull') {
      const branch = currentBranch(g.dir)
      const source = g.args.filter((a) => !a.startsWith('-')).pop() ?? ''
      if (g.sub === 'merge' && ['--abort', '--continue', '--quit'].some((a) => g.args.includes(a)))
        continue
      if (branch === 'main') {
        if (team === 'ieum-pm' && g.sub === 'pull') continue
        if (team !== 'ieum-release')
          return 'Only ieum-release merges into main, when ieum-pm asks after the user approves.'
        if (g.sub !== 'merge') return 'ieum-release only merges develop into main.'
        const sha = git(g.dir, ['rev-parse', source || 'develop'])
        if (!(readApprovals().mainMerge ?? []).some((a) => a.commit && sha.startsWith(a.commit)))
          return `Merging ${source} (${sha.slice(0, 12)}) into main needs the user's approval in .claude/agent-approvals.json ({"mainMerge":[{"commit":"${sha.slice(0, 12)}"}]}). Ask ieum-pm.`
      }
      if (branch === 'develop' && g.sub === 'merge') {
        const m = /(?:^|\/)(feature|design)\/(\d+)-/.exec(source)
        if (source.endsWith('main') && ['ieum-designer', 'ieum-developer'].includes(team)) continue
        if (!m)
          return `Only feature/<issue>-* and design/<epic>-* branches are merged into develop, not ${source}.`
        if (m[1] === 'feature' && team !== 'ieum-developer')
          return 'Only the dev lead merges feature branches into develop.'
        if (m[1] === 'design' && team !== 'ieum-designer')
          return 'Only analysis/design merges design branches into develop.'
        let labels
        try {
          labels = issueLabels(m[2])
        } catch {
          return `Could not read the labels of #${m[2]}; merging into develop needs qa:approved on it.`
        }
        if (!labels.includes('qa:approved'))
          return `#${m[2]} has no qa:approved label. Request a QA round from ieum-qa first.`
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Notices

function notify(title, body) {
  if (process.env.IEUM_HOOK_NO_NOTIFY === '1') return
  try {
    if (process.platform === 'darwin')
      execFileSync(
        'osascript',
        ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`],
        { timeout: 3000, stdio: 'ignore' },
      )
  } catch {
    // a missing notifier is not worth failing a hook over
  }
}

function log(entry) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true })
    appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    // logging never blocks the work
  }
}

/** Notices after a Bash call: repeated QA findings, design changes, labels for people. */
export function noticesAfterBash(team, command, cwd) {
  const notes = []
  for (const cmd of analyzeCommand(command, cwd)) {
    const w = cmd.words
    if (w[0] !== 'gh' || w[1] !== 'issue') continue
    const issue =
      w.slice(3).find((x) => /^\d+$/.test(x)) ?? (/^\d+$/.test(w[3] ?? '') ? w[3] : null)
    if (w[2] === 'edit' || w[2] === 'create') {
      const labels = w.flatMap((x, i) =>
        x === '--add-label' || x === '--label' || x === '-l' ? w[i + 1].split(',') : [],
      )
      if (labels.includes('needs-user')) {
        notes.push(
          `needs-user on #${issue ?? 'new issue'}: ieum-pm must ask the user through SendMessage to "main" and wait.`,
        )
        notify('IeumOffice: user decision needed', `#${issue ?? 'new'} needs your decision`)
      }
      if (labels.includes('escalation')) {
        notes.push(
          `escalation on #${issue ?? 'new issue'}: stop debating it and send it to ieum-pm.`,
        )
        notify('IeumOffice: escalation', `#${issue ?? 'new'} was escalated to PM`)
      }
    }
    if (w[2] === 'comment' && issue) {
      let data
      try {
        data = ghJson(['issue', 'view', issue, '--json', 'comments,labels'])
      } catch {
        continue
      }
      const labels = data.labels.map((l) => l.name)
      if (labels.includes('escalation')) continue
      const counts = new Map()
      for (const c of data.comments) {
        if (!/QA round/i.test(c.body)) continue
        for (const id of new Set(c.body.match(/QA-\d+-\d+/g) ?? []))
          counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      const repeated = [...counts].filter(([, n]) => n >= 3).map(([id]) => id)
      if (repeated.length > 0) {
        notes.push(
          `#${issue}: ${repeated.join(', ')} came up in 3 or more QA rounds. Per docs/process/agent-workflow.md add the escalation label and SendMessage to ieum-pm now; do not run another round on it.`,
        )
        notify('IeumOffice: 3rd QA round', `#${issue} ${repeated.join(', ')} → PM`)
      }
      const changes = data.comments.filter((c) => /^\s*\[design-change\]/i.test(c.body)).length
      if (changes >= 3)
        notes.push(
          `#${issue}: ${changes} design-change rounds. Escalate to ieum-pm (label escalation + SendMessage).`,
        )
    }
  }
  return notes
}

/** Bash commands run since the last prompt, from the transcript. */
function commandsThisTurn(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return []
  const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n')
  const cmds = []
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    const content = entry.message?.content
    if (entry.type === 'user' && typeof content === 'string') break
    if (entry.type === 'user' && Array.isArray(content) && content.some((c) => c.type === 'text'))
      break
    if (entry.type === 'assistant' && Array.isArray(content))
      for (const c of content)
        if (c.type === 'tool_use' && c.name === 'Bash' && c.input?.command)
          cmds.push(c.input.command)
  }
  return cmds
}

export function missingHandoff(transcriptPath) {
  const cmds = commandsThisTurn(transcriptPath)
  const changed = cmds.some((c) =>
    /\bgit\s+(commit|push|merge)\b|\bgh\s+(pr|issue)\s+create\b/.test(c),
  )
  const handedOff = cmds.some((c) => /\[handoff\]/.test(c))
  return changed && !handedOff
}

// ---------------------------------------------------------------------------

function teamOf(input) {
  if (TEAMS.has(input.agent_type)) return input.agent_type
  if (TEAMS.has(process.env.IEUM_TEAM)) return process.env.IEUM_TEAM
  return null
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function deny(team, input, reason) {
  log({
    team,
    event: 'deny',
    tool: input.tool_name,
    reason,
    command: input.tool_input?.command,
    path: input.tool_input?.file_path,
  })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[ieum-guard] ${reason}`,
      },
    }),
  )
}

function main() {
  const raw = readStdin()
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }
  const team = teamOf(input)
  if (!team) return
  const event = input.hook_event_name

  if (event === 'PreToolUse') {
    try {
      let reason = null
      if (input.tool_name === 'Bash')
        reason = denyBash(team, input.tool_input?.command ?? '', input.cwd)
      else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) {
        const p = input.tool_input?.file_path ?? input.tool_input?.notebook_path
        if (p) reason = writeRule(team, p)
      }
      if (reason) deny(team, input, reason)
    } catch (err) {
      // fail closed: an unreadable situation is not a permission
      deny(
        team,
        input,
        `The guard could not check this call (${err.message}). Fix tools/agent-hooks/guard.mjs or ask a person.`,
      )
    }
    return
  }

  if (event === 'PostToolUse' && input.tool_name === 'Bash') {
    const notes = noticesAfterBash(team, input.tool_input?.command ?? '', input.cwd)
    if (notes.length > 0) {
      log({ team, event: 'notice', notes })
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: `[ieum-guard] ${notes.join(' ')}`,
          },
        }),
      )
    }
    return
  }

  if ((event === 'Stop' || event === 'SubagentStop') && !input.stop_hook_active) {
    const transcript =
      event === 'SubagentStop'
        ? (input.agent_transcript_path ?? input.transcript_path)
        : input.transcript_path
    if (missingHandoff(transcript)) {
      const reason =
        '[ieum-guard] You changed branches or issues in this turn but left no [handoff] comment. Post one on the issue (format in docs/process/agent-workflow.md, "기록") and SendMessage the next team, then stop.'
      log({ team, event: 'handoff-missing' })
      process.stdout.write(JSON.stringify({ decision: 'block', reason }))
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
