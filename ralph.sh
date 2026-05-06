#!/usr/bin/env bash
# Ralph autonomous agent loop for AI-driven development via GitHub Copilot CLI.
# Implements the soderlind/ralph pattern: AI reads PRD -> implements one feature
# -> verifies -> updates PRD -> commits -> repeats until <promise>COMPLETE</promise>.

set -euo pipefail

ITERATIONS=25
MODEL="gpt-5.2"
ALLOW_PROFILE="safe"
DRY_RUN=0

usage() {
    cat <<EOF
Usage: $0 [options]
  --iterations N        Max iterations (default 25)
  --model NAME          Model id (default gpt-5.2)
  --allow-profile P     safe | dev | locked (default safe)
  --dry-run             Print the copilot command without executing it
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --iterations)    ITERATIONS="$2"; shift 2 ;;
        --model)         MODEL="$2"; shift 2 ;;
        --allow-profile) ALLOW_PROFILE="$2"; shift 2 ;;
        --dry-run)       DRY_RUN=1; shift ;;
        -h|--help)       usage; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

PROJECT_ROOT="$(pwd)"
PRD_FILE="$PROJECT_ROOT/scripts/ralph/prd.json"
PROGRESS_FILE="$PROJECT_ROOT/progress.txt"
PROMPT_FILE="$PROJECT_ROOT/prompts/default.txt"

for f in "$PRD_FILE" "$PROGRESS_FILE" "$PROMPT_FILE"; do
    [[ -f "$f" ]] || { echo "Required file missing: $f" >&2; exit 1; }
done

DENY_ALWAYS=( "shell(rm)" "shell(git push)" )

case "$ALLOW_PROFILE" in
    safe)
        ALLOW=( "write" "shell(git*)" "shell(npm*)" "shell(node*)" "shell(python*)" "shell(bash*)" )
        DENY=( "${DENY_ALWAYS[@]}" )
        ;;
    dev)
        ALLOW=( "write" "shell" )
        DENY=( "${DENY_ALWAYS[@]}" )
        ;;
    locked)
        ALLOW=( "write" )
        DENY=( "${DENY_ALWAYS[@]}" "shell" )
        ;;
    *) echo "Invalid --allow-profile: $ALLOW_PROFILE" >&2; exit 1 ;;
esac

TOOL_ARGS=()
for a in "${ALLOW[@]}"; do TOOL_ARGS+=( --allow-tool "$a" ); done
for d in "${DENY[@]}";  do TOOL_ARGS+=( --deny-tool  "$d" ); done

echo "Ralph loop starting"
echo "  Project    : $PROJECT_ROOT"
echo "  Iterations : $ITERATIONS"
echo "  Model      : $MODEL"
echo "  Profile    : $ALLOW_PROFILE"
echo "  DryRun     : $DRY_RUN"
echo

for ((i=1; i<=ITERATIONS; i++)); do
    echo "=== Iteration $i / $ITERATIONS ==="

    CTX_FILE="$(mktemp -t ralph-ctx-XXXXXX.md)"

    {
        echo "# Ralph Iteration $i Context"
        echo
        echo "## PRD (scripts/ralph/prd.json)"
        echo '```json'
        cat "$PRD_FILE"
        echo '```'
        echo
        echo "## Progress Log (progress.txt)"
        echo '```'
        cat "$PROGRESS_FILE"
        echo '```'
        echo
        echo "## Iteration Prompt"
        cat "$PROMPT_FILE"
    } > "$CTX_FILE"

    USER_PROMPT="@$CTX_FILE Follow the attached prompt."

    CMD=( copilot --add-dir "$PROJECT_ROOT" --model "$MODEL" --no-color --stream off --silent -p "$USER_PROMPT" "${TOOL_ARGS[@]}" )

    if [[ $DRY_RUN -eq 1 ]]; then
        echo "DRY RUN: ${CMD[*]}"
        rm -f "$CTX_FILE"
        continue
    fi

    OUTPUT="$("${CMD[@]}" 2>&1 || true)"
    echo "$OUTPUT"
    rm -f "$CTX_FILE"

    if grep -qE '<promise>[[:space:]]*COMPLETE[[:space:]]*</promise>' <<<"$OUTPUT"; then
        echo "PRD reported COMPLETE on iteration $i. Stopping."
        break
    fi
done

echo "Ralph loop finished."
