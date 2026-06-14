#!/bin/bash
# Hook: SessionStart
# Registers the project repo (idempotent) and kicks off a full repo analysis
# in the background — per PRD.md M6, full-repo analysis may take time, so
# this is fire-and-forget. Subsequent PreToolUse/PostToolUse hooks read
# whatever results are available via get-file-analysis/analyse-file.
#
# Requires: mcp-sonar-analysis-cli on PATH (see README "Installation") and jq.

input=$(cat)

proj_dir=$(jq -r '.cwd // empty' <<< "$input")
if [ -z "$proj_dir" ]; then
  exit 0
fi

register_output=$(mcp-sonar-analysis-cli register-repo "$proj_dir" 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 0
fi

# Background, non-blocking full-repo scan.
(mcp-sonar-analysis-cli analyse-repo "$proj_dir" > /dev/null 2>&1 &)

repo_id=$(echo "$register_output" | jq -r '.repoId // empty')
already=$(echo "$register_output" | jq -r '.alreadyRegistered // false')

context="mcp-sonar-analysis: repo registered (repoId=$repo_id, alreadyRegistered=$already). A background analysis was started; PreToolUse/PostToolUse hooks will surface per-file findings as you edit."

jq -n --arg ctx "$context" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
