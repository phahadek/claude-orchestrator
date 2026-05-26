FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# claude binary is mounted at runtime via -v, not baked in
# ~/.claude credentials are mounted at runtime via -v

WORKDIR /workspace

ENV NODE_ENV=production
