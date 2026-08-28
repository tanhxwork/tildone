#!/usr/bin/env bash
# Pins the three places that assert the built-in dispatch → model-tier map:
#
#   1. the `case` table in .claude/hooks/agent-model-tier-guard.sh (what runs)
#   2. `used_by: - Agent(<type>)` under a role's `model:` in .claude/agent-models.yaml
#      (what the docs promise)
#   3. the once-per-session note the hook injects ("Explore→haiku, …"), which
#      is what the model reads and believes
#
# Zeno lesson (2026-08-28): a runner and its validator disagreed on a command's
# shape and every harness test still passed, because nothing compared them.
# This test runs the real hook for every built-in type the yaml names and
# fails if any of the three disagree. Prove it bites by mutating the hook:
#
#   sed 's/Explore)\(.*\)"haiku"/Explore)\1"sonnet"/' \
#     .claude/hooks/agent-model-tier-guard.sh > /tmp/mutant.sh
#   TIER_GUARD_HOOK=/tmp/mutant.sh scripts/tests/agent-model-tier-guard.test.sh  # → FAIL
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd -P)
hook=${TIER_GUARD_HOOK:-$repo_root/.claude/hooks/agent-model-tier-guard.sh}
yaml=${TIER_GUARD_YAML:-$repo_root/.claude/agent-models.yaml}
scratch=$(mktemp -d -t tildone-tier-guard)
trap 'rm -rf "$scratch"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
[[ -f "$hook" ]] || fail "hook not found: $hook"
[[ -f "$yaml" ]] || fail "yaml not found: $yaml"
command -v jq >/dev/null || fail "jq required"

# Run the hook exactly as Claude Code would: PreToolUse payload on stdin, a
# project dir for the session marker, a fresh session id so the note fires.
run_hook() {
  local subtype=$1 model=${2:-}
  local payload
  payload=$(jq -nc --arg t "$subtype" --arg m "$model" \
    '{session_id: ("tier-guard-test-" + (now|tostring)), hook_event_name: "PreToolUse", tool_name: "Agent",
      tool_input: ({subagent_type: $t, prompt: "x", description: "y"} + (if $m != "" then {model: $m} else {} end))}')
  mkdir -p "$scratch/project/.claude"
  echo "$payload" | CLAUDE_PROJECT_DIR="$scratch/project" bash "$hook"
}

# 2. what the yaml promises: `model: X` … `- Agent(Type)` inside one role block.
yaml_map=$(awk '
  /^[[:space:]]+model:[[:space:]]*[a-z]/ { m=$2 }
  match($0, /- Agent\(([A-Za-z-]+)\)/, a) { print a[1], m }
' "$yaml" 2>/dev/null || true)
if [[ -z "$yaml_map" ]]; then
  # BSD awk has no match(..., arr); fall back to sed.
  yaml_map=$(awk '/^[[:space:]]+model:[[:space:]]*[a-z]/ { m=$2 } /- Agent\(/ { line=$0; sub(/.*- Agent\(/, "", line); sub(/\).*/, "", line); print line, m }' "$yaml")
fi
[[ -n "$yaml_map" ]] || fail "no 'used_by: - Agent(<type>)' entries found in $yaml"

checked=0
while read -r subtype want; do
  [[ -n "$subtype" ]] || continue
  out=$(run_hook "$subtype")
  got=$(echo "$out" | jq -r '.hookSpecificOutput.updatedInput.model // ""')
  [[ "$got" == "$want" ]] || fail "hook injects model='$got' for Agent($subtype); agent-models.yaml says '$want'"
  # 3. the note the model reads must name the same pair.
  note=$(echo "$out" | jq -r '.hookSpecificOutput.additionalContext // ""')
  [[ -n "$note" ]] || fail "hook emitted no session note for Agent($subtype) on a fresh session"
  echo "$note" | grep -q "${subtype}→${want}" || fail "hook note does not say '${subtype}→${want}': $note"
  checked=$((checked + 1))
done <<< "$yaml_map"

# general-purpose has no Agent(...) line in the yaml (it is the unnamed floor);
# pin the case table against the note instead so the two cannot drift.
out=$(run_hook "general-purpose")
got=$(echo "$out" | jq -r '.hookSpecificOutput.updatedInput.model // ""')
note=$(echo "$out" | jq -r '.hookSpecificOutput.additionalContext // ""')
[[ -n "$got" ]] || fail "hook did not pin general-purpose"
echo "$note" | grep -q "general-purpose→${got}" || fail "hook pins general-purpose to '$got' but its note says otherwise: $note"
checked=$((checked + 1))

# Discipline held → hook stays silent (an explicit model is never overridden),
# and a custom agent (self-pinned in frontmatter) is left alone.
[[ -z "$(run_hook Explore opus)" ]] || fail "hook rewrote an explicit model"
[[ -z "$(run_hook implementer)" ]] || fail "hook touched a custom agent type"

echo "PASS agent-model-tier-guard: hook, agent-models.yaml and the injected note agree on $checked built-in types"
