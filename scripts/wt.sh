#!/usr/bin/env bash
# wt.sh — the git-worktree workflow for this SHARED agent-os checkout.
#
# Several Claude sessions (and the fleet) edit this one checkout concurrently. Two sessions writing the
# same files — or one running `git switch` under another — silently clobber each other. So the PRIMARY
# checkout (the one on `main`) is kept clean and on `main`, used only to run the live service and to
# integrate finished work; ALL development happens in per-session worktrees under ~/aos-wt/<name>.
# See CLAUDE.md → "Multi-session development (git worktrees)".
#
# Usage:
#   scripts/wt.sh new <name>          # ~/aos-wt/<name> on feat/<name> off origin/main (+node_modules)
#   scripts/wt.sh list                # show all worktrees
#   scripts/wt.sh sync                # ff-pull main in the primary checkout
#   scripts/wt.sh integrate <name..>  # fresh batch/<ts> worktree off origin/main, merge feat/<name..>
#   scripts/wt.sh done <name>         # remove the worktree and delete feat/<name>
#
# Portable to macOS bash 3.2 + BSD userland (the deploy box is Linux, dev is a Mac).
set -eu

WT_HOME="${AOS_WT_HOME:-$HOME/aos-wt}"

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '\033[36m%s\033[0m\n' "$*"; }

# The primary worktree is always the first entry `git worktree list` prints (the non-linked checkout).
# Resolving it lets every subcommand run from ANY worktree and still drive the right checkout.
PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
[ -n "$PRIMARY" ] || die "not inside an agent-os git checkout"

# Symlink the primary checkout's node_modules into a worktree so typecheck/build run with no install.
link_modules() {
  wt="$1"
  [ -d "$PRIMARY/node_modules" ] && [ ! -e "$wt/node_modules" ] && ln -s "$PRIMARY/node_modules" "$wt/node_modules" || true
  [ -d "$PRIMARY/web/node_modules" ] && [ ! -e "$wt/web/node_modules" ] && ln -s "$PRIMARY/web/node_modules" "$wt/web/node_modules" || true
}

cmd="${1:-}"; shift 2>/dev/null || true
case "$cmd" in
  new)
    name="${1:-}"; [ -n "$name" ] || die "usage: wt.sh new <name>"
    dir="$WT_HOME/$name"; branch="feat/$name"
    [ -e "$dir" ] && die "worktree dir already exists: $dir"
    git -C "$PRIMARY" fetch origin --quiet
    mkdir -p "$WT_HOME"
    git -C "$PRIMARY" worktree add "$dir" -b "$branch" origin/main
    link_modules "$dir"
    say "ready: $dir  (branch $branch off origin/main)"
    echo "  cd \"$dir\"   # develop + commit; then: scripts/wt.sh integrate $name"
    ;;
  list)
    git -C "$PRIMARY" worktree list
    ;;
  sync)
    git -C "$PRIMARY" switch main
    git -C "$PRIMARY" fetch origin --quiet
    git -C "$PRIMARY" merge --ff-only origin/main
    say "primary synced to origin/main: $(git -C "$PRIMARY" rev-parse --short main)"
    ;;
  integrate)
    [ "$#" -ge 1 ] || die "usage: wt.sh integrate <name> [<name>...]"
    git -C "$PRIMARY" fetch origin --quiet
    stamp="$(date +%Y%m%d-%H%M)"
    branch="batch/$stamp"; dir="$WT_HOME/_batch-$stamp"
    git -C "$PRIMARY" worktree add "$dir" -b "$branch" origin/main
    link_modules "$dir"
    for name in "$@"; do
      say "merging feat/$name into $branch …"
      git -C "$dir" merge --no-ff "feat/$name" -m "Merge feat/$name into $branch"
    done
    say "batch worktree ready: $dir  (branch $branch ← $*)"
    echo "  cd \"$dir\", then: bump version + CHANGELOG once for the batch, and"
    echo "    npm run build && (cd web && npm run build) && npm run test:governance"
    echo "    git push -u origin $branch"
    echo "    gh pr create --repo vikasprogrammer/agent-os --base main --head $branch ... && gh pr merge --squash"
    ;;
  done)
    name="${1:-}"; [ -n "$name" ] || die "usage: wt.sh done <name>"
    dir="$WT_HOME/$name"
    rm -f "$dir/node_modules" "$dir/web/node_modules" 2>/dev/null || true
    git -C "$PRIMARY" worktree remove --force "$dir"
    git -C "$PRIMARY" branch -D "feat/$name" 2>/dev/null || true
    git -C "$PRIMARY" worktree prune
    say "removed worktree $dir and branch feat/$name"
    ;;
  *)
    die "usage: wt.sh {new|list|sync|integrate|done} ..."
    ;;
esac
