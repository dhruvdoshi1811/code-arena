# Execution image for JavaScript submissions.
FROM node:24-alpine

# node:alpine ships a `node` user at 1000.
RUN addgroup -g 65532 -S runner && adduser -u 65532 -S runner -G runner

RUN mkdir -p /workspace && chown runner:runner /workspace

USER 65532:65532
WORKDIR /workspace

CMD ["node", "/workspace/main.js"]
