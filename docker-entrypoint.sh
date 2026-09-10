#!/bin/sh
# Prepare the two mounted directories before handing off to the server.
#
# Both $HOME and $AGENT_OS_HOME are bind mounts, so whatever the image baked at those paths is
# hidden at runtime. `~/.claude` in particular has to exist and be writable before the first agent
# session launches — claude-launch.sh seeds `~/.claude.json` and the CLI keeps its credentials and
# transcripts under `~/.claude`. A read-only or missing HOME is the folder-trust-dialog hang.
set -e

mkdir -p "${AGENT_OS_HOME:-/data}" "${HOME}/.claude"

if ! touch "${HOME}/.aos-write-probe" 2>/dev/null; then
  echo "FATAL: \$HOME (${HOME}) is not writable — every agent session would hang on Claude Code's" >&2
  echo "       folder-trust dialog. Fix the volume ownership (uid $(id -u)) and redeploy." >&2
  exit 1
fi
rm -f "${HOME}/.aos-write-probe"

exec "$@"
