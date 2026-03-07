#!/usr/bin/env bash
# Build every image, load them into the kind cluster, and apply the manifests.
#
#   ./infra/deploy.sh          build, load, apply, wait
#   ./infra/deploy.sh --skip-build   apply only (fast iteration on manifests)
#
# Idempotent: safe to re-run. Creates the cluster and installs the ingress controller if
# they are missing.
set -euo pipefail

CLUSTER=codearena
INGRESS_HOST=http://localhost:8081   # must match hostPort in infra/kind/cluster.yaml
TAG=0.1.0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  step "Creating cluster"
  kind create cluster --config "$ROOT/infra/kind/cluster.yaml"
fi

if ! kubectl get ns ingress-nginx >/dev/null 2>&1; then
  step "Installing ingress-nginx"
  kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
  kubectl wait --namespace ingress-nginx --for=condition=ready pod \
    --selector=app.kubernetes.io/component=controller --timeout=300s
fi

if [[ "${1:-}" != "--skip-build" ]]; then
  step "Building images"
  docker build -q -t "codearena/gateway:$TAG"      "$ROOT/services/gateway"
  docker build -q -t "codearena/orchestrator:$TAG" "$ROOT/services/orchestrator"
  docker build -q -t "codearena/web:$TAG" --build-arg "VITE_GATEWAY_URL=$INGRESS_HOST" "$ROOT/web"
  docker build -q -t "codearena/exec-python:$TAG"     "$ROOT/infra/images/python"
  docker build -q -t "codearena/exec-javascript:$TAG" "$ROOT/infra/images/javascript"

  step "Loading images into the cluster"
  # kind nodes have their own image store; images on the host are not visible to the
  # kubelet until they are loaded, which is why every Job uses imagePullPolicy:
  # IfNotPresent rather than Always.
  kind load docker-image --name "$CLUSTER" \
    "codearena/gateway:$TAG" \
    "codearena/orchestrator:$TAG" \
    "codearena/web:$TAG" \
    "codearena/exec-python:$TAG" \
    "codearena/exec-javascript:$TAG"
fi

step "Applying manifests"
kubectl apply -f "$ROOT/infra/k8s/execution-namespace.yaml"
kubectl apply -f "$ROOT/infra/k8s/00-namespace.yaml"
kubectl apply -f "$ROOT/infra/k8s/10-config.yaml"
kubectl apply -f "$ROOT/infra/k8s/20-postgres.yaml"
kubectl apply -f "$ROOT/infra/k8s/21-redis.yaml"
kubectl apply -f "$ROOT/infra/k8s/22-redpanda.yaml"

step "Waiting for datastores"
kubectl -n codearena rollout status statefulset/postgres --timeout=300s
kubectl -n codearena rollout status statefulset/redis    --timeout=300s
kubectl -n codearena rollout status statefulset/redpanda --timeout=420s

step "Running migrations"
# Jobs are immutable, so a redeploy must replace rather than patch.
kubectl -n codearena delete job codearena-migrate --ignore-not-found
kubectl apply -f "$ROOT/infra/k8s/30-migrate-job.yaml"
kubectl -n codearena wait --for=condition=complete job/codearena-migrate --timeout=300s

step "Deploying services"
kubectl apply -f "$ROOT/infra/k8s/41-orchestrator.yaml"
kubectl apply -f "$ROOT/infra/k8s/40-gateway.yaml"
kubectl apply -f "$ROOT/infra/k8s/42-web.yaml"
kubectl apply -f "$ROOT/infra/k8s/50-ingress.yaml"

# Restart so a rebuilt image with an unchanged tag is actually picked up.
if [[ "${1:-}" != "--skip-build" ]]; then
  kubectl -n codearena rollout restart deployment/gateway deployment/orchestrator deployment/web
fi

kubectl -n codearena rollout status deployment/gateway      --timeout=300s
kubectl -n codearena rollout status deployment/orchestrator --timeout=300s
kubectl -n codearena rollout status deployment/web          --timeout=300s

step "Ready"
kubectl -n codearena get pods
printf '\nCodeArena is running at \033[1m%s\033[0m\n\n' "$INGRESS_HOST"
