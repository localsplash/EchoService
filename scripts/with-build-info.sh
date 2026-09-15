#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export BUILD_REVISION="$(git rev-parse HEAD)"
export SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)"
if [ -z "$(git status --porcelain)" ]; then
  export BUILD_DIRTY=false
else
  export BUILD_DIRTY=true
fi
exec "$@"
