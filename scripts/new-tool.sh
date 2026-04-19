#!/usr/bin/env bash
set -euo pipefail

tool_id=${1:-}
if [[ -z $tool_id ]]; then
  echo 'Usage: ./scripts/new-tool.sh TOOL_ID [--kind command|pre-model] [--command CMD]' >&2
  exit 1
fi
shift

node scripts/scaffold-tool.mjs $tool_id $@

echo
echo Next:
echo 1) Implement src/tools/$tool_id.ts
echo 2) Enable the tool env flag in .env
echo 3) Run: npm test
