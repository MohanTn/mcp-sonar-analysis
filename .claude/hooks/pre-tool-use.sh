#!/bin/bash
# Hook: PreToolUse
# Triggered before Edit/Read operations.
# Extracts file path and provides relevant analysis context.
#
# Requires: mcp-sonar-analysis-cli on PATH (see README "Installation") and jq.

input=$(cat)

# Extract project dir
proj_dir=$(jq -r '.cwd // empty' <<< "$input")
if [ -z "$proj_dir" ]; then
  exit 0
fi

# Extract file path from tool input (absolute path; core functions normalize
# this to a repo-relative path internally)
file_path=$(jq -r '.tool_input.file_path // empty' <<< "$input")
if [ -z "$file_path" ]; then
  exit 0
fi

# Get file analysis
analysis=$(mcp-sonar-analysis-cli get-file-analysis "$proj_dir" "$file_path" 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 0
fi

# Extract issue summary
issue_count=$(echo "$analysis" | jq '.issues | length')
context=""
if [ "$issue_count" -gt 0 ]; then
  context="File has $issue_count issues detected. "
fi

context="${context}File analysis available for context."

jq -n \
  --arg ctx "$context" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}'
