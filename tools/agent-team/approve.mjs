#!/usr/bin/env node
/**
 * Record a person's approval for the agent team hooks: .claude/agent-approvals.json
 *
 * The hook guard (tools/agent-hooks/guard.mjs) lets a team do three things only
 * with an approval recorded here, and denies every team from running this
 * script or writing the file. A person runs it in a terminal and confirms.
 *
 * Usage:
 *   node tools/agent-team/approve.mjs engine <path/> [--issue N]   allow edits under an engine path
 *   node tools/agent-team/approve.mjs main-merge [ref]             allow merging ref (default develop) into main
 *   node tools/agent-team/approve.mjs release <version>            allow creating release/<version>
 *   node tools/agent-team/approve.mjs list                         print the recorded approvals
 *   node tools/agent-team/approve.mjs revoke engine|main-merge|release   drop all approvals of a kind
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FILE = join(ROOT, '.claude', 'agent-approvals.json')
const POLICY = JSON.parse(readFileSync(join(ROOT, 'tools/agent-hooks/policy.json'), 'utf8'))
const KEYS = { engine: 'engine', 'main-merge': 'mainMerge', release: 'release' }

function load() {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}
}

function save(data) {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n')
}

function fail(message) {
  console.error(`approve: ${message}`)
  process.exit(2)
}

async function confirm(question) {
  if (!process.stdin.isTTY) fail('run this yourself in a terminal; it needs a typed confirmation')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} Type "yes" to approve: `)
  rl.close()
  return answer.trim() === 'yes'
}

const [kind, arg, ...rest] = process.argv.slice(2)
const data = load()
const now = new Date().toISOString()

if (kind === 'list' || kind === undefined) {
  console.log(JSON.stringify(data, null, 2))
} else if (kind === 'revoke') {
  if (!KEYS[arg]) fail('revoke engine|main-merge|release')
  delete data[KEYS[arg]]
  save(data)
  console.log(`revoked all ${arg} approvals`)
} else if (kind === 'engine') {
  const path = arg?.endsWith('/') ? arg : arg ? `${arg}/` : ''
  if (!POLICY.enginePaths.some((e) => e === path || path.startsWith(e)))
    fail(`not an engine path; one of: ${POLICY.enginePaths.join(' ')}`)
  const i = rest.indexOf('--issue')
  const issue = i >= 0 ? Number(rest[i + 1]) : undefined
  if (await confirm(`Allow the agent teams to change ${path}${issue ? ` for #${issue}` : ''}?`)) {
    data.engine = [...(data.engine ?? []), { path, issue, approvedAt: now }]
    save(data)
    console.log('approved')
  }
} else if (kind === 'main-merge') {
  const ref = arg ?? 'develop'
  if (!process.stdin.isTTY) fail('run this yourself in a terminal; it needs a typed confirmation')
  let sha
  try {
    sha = execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', `${ref}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    fail(`no such branch or commit: ${ref}`)
  }
  const log = execFileSync('git', ['-C', ROOT, 'log', '--oneline', `main..${sha}`], {
    encoding: 'utf8',
  }).trim()
  console.log(`Commits that would enter main:\n${log || '(none)'}`)
  if (await confirm(`Allow ieum-release to merge ${ref} at ${sha.slice(0, 12)} into main?`)) {
    data.mainMerge = [...(data.mainMerge ?? []), { ref, commit: sha.slice(0, 12), approvedAt: now }]
    save(data)
    console.log('approved')
  }
} else if (kind === 'release') {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(arg ?? '')) fail('release <version>, e.g. release 0.13.0')
  if (await confirm(`Allow ieum-release to create release/${arg}?`)) {
    data.release = [...(data.release ?? []), { version: arg, approvedAt: now }]
    save(data)
    console.log('approved')
  }
} else {
  fail('engine <path/> | main-merge [ref] | release <version> | list | revoke <kind>')
}
