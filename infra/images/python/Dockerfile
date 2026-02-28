# Execution image for Python submissions.
FROM python:3.13-alpine

# A real user rather than relying solely on the Job's runAsUser.
RUN addgroup -g 65532 -S runner && adduser -u 65532 -S runner -G runner

# The mount point.
RUN mkdir -p /workspace && chown runner:runner /workspace

USER 65532:65532
WORKDIR /workspace

# Unbuffered.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

CMD ["python", "/workspace/main.py"]
