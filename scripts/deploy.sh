#!/usr/bin/env bash
# Build on Cloud Build and deploy to Cloud Run. Usage: npm run deploy
set -euo pipefail

PROJECT="${PROJECT:-adder-app-511522}"
REGION="${REGION:-europe-west1}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty; commit or stash first so the deploy matches a commit." >&2
  exit 1
fi

gcloud run deploy adder \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 256Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --concurrency 200 \
  --labels "commit=$(git rev-parse --short HEAD)"
