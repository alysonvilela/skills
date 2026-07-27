# Sandbox image for eval-reviewer personas, used only by docker mode.
#
# One image serves every repo on the machine: reviewers read code, they do not
# build or run it, so nothing project-specific belongs here. Built on the first
# docker-mode run, tagged with whatever `docker.image` says in the config.
FROM node:24-bookworm-slim

# Which coding agent this image reviews with — one CLI per image rather than
# one image carrying all of them. The runner passes the package that matches
# `agent.provider` in the config.
ARG AGENT_NPM_PACKAGE=@earendil-works/pi-coding-agent

# UID/GID alignment: bind-mounted worktree files must share an owner with the
# container user, or the agent cannot write its session files. The runner passes
# the host's UID/GID; Sandcastle's docker provider verifies the match.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# git: Sandcastle runs the persona inside a git worktree.
# ripgrep: what every one of these CLIs reaches for to search a codebase.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
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
