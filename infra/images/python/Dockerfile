# Execution image for Python submissions.
#
# Built locally and loaded into kind; pushed to ECR in Phase F. It carries no CodeArena
# code — the submission arrives as a read-only ConfigMap mount at /workspace, so the
# image is a language runtime and nothing else.
FROM python:3.13-alpine

# A real user rather than relying solely on the Job's runAsUser, so the image is
# non-root even if something ever runs it outside our Job spec.
RUN addgroup -g 65532 -S runner && adduser -u 65532 -S runner -G runner

# The mount point. Created here because the root filesystem is read-only at runtime,
# so the kubelet cannot create it for us.
RUN mkdir -p /workspace && chown runner:runner /workspace

USER 65532:65532
WORKDIR /workspace

# Unbuffered, so output reaches the log stream as it is produced rather than sitting in
# a buffer that is discarded when a timed-out pod is killed.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

CMD ["python", "/workspace/main.py"]
