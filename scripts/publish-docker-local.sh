#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${1:-$(node -p "require('./package.json').version")}"
IMAGE_NAME="${IMAGE_NAME:-ghcr.io/jenkinwoo/cloud-manager}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

SHA_TAG=""
if git rev-parse --short=12 HEAD >/dev/null 2>&1; then
  SHA_TAG="$(git rev-parse --short=12 HEAD)"
fi

echo "Publishing ${IMAGE_NAME}:${VERSION}"
echo "Platforms: ${PLATFORMS}"

set -- \
  docker buildx build \
  --platform "$PLATFORMS" \
  --push \
  -t "${IMAGE_NAME}:latest" \
  -t "${IMAGE_NAME}:${VERSION}"

if [ -n "$SHA_TAG" ]; then
  set -- "$@" -t "${IMAGE_NAME}:${SHA_TAG}"
fi

set -- "$@" .

"$@"
