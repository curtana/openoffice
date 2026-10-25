#!/bin/sh
# Start one team session of the agent team process (docs/process/agent-workflow.md).
#
# Usage:
#   tools/agent-team/start.sh pm|designer|developer|qa|release [claude args...]
#   tools/agent-team/start.sh worker <issue> [claude args...]
#   tools/agent-team/start.sh --window <same arguments>
#
# Each session runs .claude/agents/ieum-<team>.md as its main thread, answers
# to its name for SendMessage, keeps its own task list (~/.claude/tasks/<name>/)
# and may work in the worktrees next to the repository (../openoffice-worktrees).
# A work order gets a session of its own: `worker 123` starts ieum-dev-worker
# under the name ieum-dev-123 with the task list ieum-dev-123.
#
# --window opens the session in a new terminal window (macOS Terminal) so a
# person can watch it; elsewhere it prints the command to run instead.
#
# IEUM_TEAM tells the hook guard (tools/agent-hooks/guard.mjs) which team acts.
set -eu

root="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "${1:-}" = "--window" ]; then
  shift
  cmd="'$root/tools/agent-team/start.sh'"
  for arg in "$@"; do cmd="$cmd '$arg'"; done
  if [ "$(uname)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "tell application \"Terminal\" to do script \"$cmd\"" >/dev/null
    echo "opened a Terminal window: $cmd"
  else
    echo "open a new terminal and run: $cmd"
  fi
  exit 0
fi

team="${1:-}"
case "$team" in
  pm | designer | developer | qa | release)
    shift
    agent="ieum-$team"
    name="ieum-$team"
    ;;
  worker)
    issue="${2:-}"
    case "$issue" in
      '' | *[!0-9]*)
        echo "usage: tools/agent-team/start.sh worker <issue number>" >&2
        exit 2
        ;;
    esac
    shift 2
    agent="ieum-dev-worker"
    name="ieum-dev-$issue"
    ;;
  *)
    echo "usage: tools/agent-team/start.sh [--window] pm|designer|developer|qa|release|worker <issue> [claude args...]" >&2
    exit 2
    ;;
esac

worktrees="$(dirname "$root")/openoffice-worktrees"
mkdir -p "$worktrees"
cd "$root"

export IEUM_TEAM="$agent"
export CLAUDE_CODE_TASK_LIST_ID="$name"
exec claude --agent "$agent" -n "$name" --add-dir "$worktrees" "$@"
