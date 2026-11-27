#!/bin/bash
# Build the web and compare images for arm64 and push them to ECR.
# Usage: scripts/push-images.sh <aws-region>   (run `terraform apply -target=...ecr...` first)
# Prints the image tag to pass to Terraform as image_tag.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=${1:?usage: scripts/push-images.sh <aws-region>}
NAME=${APP_NAME:-redline-diff}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
TAG=$(git rev-parse --short=12 HEAD)$(git diff --quiet HEAD -- . ':!infra' || echo "-dirty-$(date +%s)")

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >&2
# --provenance=false: Lambda does not accept multi-manifest image indexes.
docker buildx build --platform linux/arm64 --provenance=false -f Dockerfile -t "$REGISTRY/$NAME-web:$TAG" --push . >&2
docker buildx build --platform linux/arm64 --provenance=false -f Dockerfile.compare -t "$REGISTRY/$NAME-compare:$TAG" --push . >&2
echo "$TAG"
