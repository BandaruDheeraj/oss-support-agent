# syntax=docker/dockerfile:1
#
# Render runtime image for oss-support-agent.
#
# Why a custom image (and not runtime: node):
#   The repro/fix sandbox shells out to `python3 -m venv .agent-venv` per
#   workspace so pip installs don't trip PEP 668 on the host. Render's
#   stock Node base image does not include `python3-venv`, so the venv
#   bootstrap fails silently and every subsequent `pip install` errors —
#   which kept the v2 Executor from ever reaching a runnable repro.
#
# Pinned to bookworm-slim for a small image with apt available; python3,
# python3-venv, python3-pip, git and build-essential cover every tool the
# sandbox shells today.

FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-venv \
      python3-pip \
      git \
      ca-certificates \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first to maximise Docker layer cache hits on code-only changes.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source and build.
COPY . .
RUN npm run build

# Render injects PORT at runtime; the server reads it from env.
EXPOSE 3000

CMD ["npm", "start"]
