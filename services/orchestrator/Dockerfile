# Orchestrator image.
#
# franz-go, pgx and client-go are all pure Go, so CGO can be disabled and the result is a
# single static binary on a distroless base — no shell, no package manager, nothing for
# an attacker to pivot into.
FROM golang:1.26 AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/orchestrator ./cmd/orchestrator

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/orchestrator /orchestrator

# Numeric so the kubelet can verify non-root without resolving a name from the image.
# 65532 is distroless' `nonroot`, and matches the UID the execution images use.
USER 65532:65532
ENTRYPOINT ["/orchestrator"]
