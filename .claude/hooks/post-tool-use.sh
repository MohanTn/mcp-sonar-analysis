#!/bin/bash
# Hook: PostToolUse
# Triggered after Edit/Write operations.
# Re-analyzes the modified file to detect any new issues.
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

# Only process Edit and Write tool operations
tool_name=$(jq -r '.tool_name // empty' <<< "$input")
if [[ "$tool_name" != "Edit" && "$tool_name" != "Write" ]]; then
  exit 0
fi

# Analyze the file
analysis=$(mcp-sonar-analysis-cli analyse-file "$proj_dir" "$file_path" 2>/dev/null)
if [ $? -ne 0 ]; then
  exit 0
fi

# Extract issue summary
issue_count=$(echo "$analysis" | jq '.issues | length')
context=""
if [ "$issue_count" -eq 0 ]; then
  context="Post-edit analysis complete: no issues detected."
else
  context="Post-edit analysis detected $issue_count issues."
fi

jq -n \
  --arg ctx "$context" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
