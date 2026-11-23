# The box every agent run and every judge step runs in. Pinned by digest and version; the
# harness records the image id per run and refuses a counted batch when it changes.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS node
FROM python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && apt-get update && apt-get install -y --no-install-recommends git ripgrep procps ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-fund --no-audit @anthropic-ai/claude-code@2.1.178 @openai/codex@0.169.1 \
 && npm cache clean --force \
 && useradd -m -u 1000 -s /bin/bash dev && install -d -o dev -g dev -m 700 /home/dev/.codex
# No auto-updates and no telemetry: the pinned versions are the ones that run.
ENV DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 \
    PYTHONDONTWRITEBYTECODE=1 LANG=C.UTF-8
USER dev
WORKDIR /home/dev
