#!/bin/bash
# Install a skill from ClawdHub
# Usage: ./scripts/install-skill.sh <skill-name>

set -e

SKILL_NAME="$1"

if [ -z "$SKILL_NAME" ]; then
  echo "Usage: $0 <skill-name>"
  echo ""
  echo "Examples:"
  echo "  $0 weather      # Weather forecasts"
  echo "  $0 github       # GitHub CLI integration"
  echo "  $0 sonoscli     # Sonos speaker control"
  echo "  $0 obsidian     # Obsidian notes"
  echo ""
  echo "Browse all skills: https://clawdhub.com"
  exit 1
fi

# Install clawdhub CLI if needed
if ! command -v clawdhub &> /dev/null; then
  echo "Installing ClawdHub CLI..."
  npm install -g clawdhub
fi

# Install the skill to global Letta skills directory
# This is where Letta Code CLI looks for skills
SKILLS_DIR="$HOME/.letta/skills"
mkdir -p "$SKILLS_DIR"

echo "Installing skill: $SKILL_NAME to $SKILLS_DIR"
clawdhub install "$SKILL_NAME" --dir "$SKILLS_DIR"

echo ""
echo "Skill installed! It will be available to all Letta agents."
