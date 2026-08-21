#!/bin/sh
set -eu

workdir="${1:-.}"
command="${2:?validation command is required}"
target=/work/project

mkdir -p "$target"
ln -s /seed/node_modules "$target/node_modules"
find /seed \
  -path /seed/node_modules -prune -o \
  -type d -name node_modules -print | while read -r dependencies; do
  relative="${dependencies#/seed/}"
  mkdir -p "$target/$(dirname "$relative")"
  cp -a "$dependencies" "$target/$(dirname "$relative")/"
done
tar \
  --exclude='./.tmp' \
  --exclude='./tmp' \
  --exclude='./artifacts' \
  --exclude='./.git' \
  --exclude='./.git/*' \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='*/node_modules/*' \
  --exclude='./.turbo' \
  --exclude='./dist' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='./.opencode/task-state' \
  -C /workspace -cf - . | tar -C "$target" -xf -

if [ -d /workspace/.git ]; then
  export GIT_DIR=/workspace/.git
  export GIT_WORK_TREE="$target"
fi

cd "$target/$workdir"
exec /bin/sh -lc "$command"
