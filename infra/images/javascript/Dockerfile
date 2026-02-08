# Execution image for JavaScript submissions.
#
# Built locally and loaded into kind; pushed to ECR in Phase F. Carries no CodeArena
# code — the submission is mounted read-only at /workspace.
FROM node:24-alpine

# node:alpine ships a `node` user at 1000; a dedicated high UID keeps this aligned with
# the Python image and with the Job's runAsUser.
RUN addgroup -g 65532 -S runner && adduser -u 65532 -S runner -G runner

RUN mkdir -p /workspace && chown runner:runner /workspace

USER 65532:65532
WORKDIR /workspace

CMD ["node", "/workspace/main.js"]
