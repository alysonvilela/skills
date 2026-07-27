# Sandbox image for eval-reviewer personas.
#
# One image serves every repo on the machine: reviewers read code, they do not
# build or run it, so nothing project-specific belongs here. Built once by
# `scripts/setup.mjs --build`, tagged sandcastle:eval-reviewer-<agent>.
FROM node:22-bookworm-slim

# Which coding agent this image reviews with — the tag encodes it, so one image
# per agent rather than one image carrying all six CLIs.
ARG AGENT_NPM_PACKAGE=@anthropic-ai/claude-code

# UID/GID alignment: bind-mounted worktree files must share an owner with the
# container user, or the agent cannot write its session files. setup.mjs passes
# the host's UID/GID; Sandcastle's docker provider verifies the match.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# git: Sandcastle runs the persona inside a git worktree.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "$AGENT_NPM_PACKAGE" && npm cache clean --force

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Sandcastle bind-mounts the worktree and overrides the working directory at
# container start; the container just has to stay alive until then.
ENTRYPOINT ["sleep", "infinity"]
