# A disposable Linux environment for the destructive cases of the Linux Core
# service process-ownership experiment.
#
# The experiment protocol requires service-manager restart, login termination,
# reboot, and forced-termination cases that must never run against a shared
# machine. A container with its own systemd instance is destroyed after every
# run, so those cases have no lasting effect on the host.
#
# The image installs only what the matrix needs: systemd for the service
# manager, Python 3 for the reviewed child launcher, and Node.js for Dolly
# itself. It pulls no Dolly source; the run mounts the working tree read-only.
#
# Build with an explicit base so a mirror can be substituted where the default
# registry is unreachable:
#
#   docker build --build-arg BASE=docker.m.daocloud.io/library/ubuntu:24.04 \
#     -t dolly-experiment .
ARG BASE=ubuntu:24.04
FROM ${BASE}

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session \
      python3 ca-certificates procps xz-utils curl \
 && rm -rf /var/lib/apt/lists/*

# The runner and Dolly itself are Node.js programs, and the experiment must
# exercise the same runtime the deployment uses. Ubuntu 24.04 packages Node.js
# 18, which is older than the version Dolly requires and lacks behaviour the
# cross-process lock depends on, so an exact release is installed instead.
#
# `NODE_VERSION` is a build argument so a run can pin the same version the host
# uses. `NODE_TARBALL_BASE` allows a mirror where the default is unreachable.
ARG NODE_VERSION=20.20.2
ARG NODE_TARBALL_BASE=https://nodejs.org/dist
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "${NODE_TARBALL_BASE}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      -o /tmp/node.tar.xz; \
    mkdir -p /usr/local/lib/nodejs; \
    tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs --strip-components=1; \
    rm /tmp/node.tar.xz; \
    ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node; \
    ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm; \
    node --version

# systemd in a container must not try to manage host-owned units. Removing the
# units that expect real hardware keeps the boot quiet and fast.
RUN find /etc/systemd/system /lib/systemd/system \
      -path '*.wants/*' \
      \( -name '*udev*' -o -name '*getty*' -o -name '*remote-fs*' \) \
      -exec rm -f {} + 2>/dev/null || true

# The experiment runs as a new unprivileged account with its own systemd user
# manager, which is the deployment shape Architecture Decision Record 0009
# describes for a user service. It deliberately does not reuse the numeric
# owner of the host checkout: doing so would make owner-only credentials such
# as an ignored `.env` readable through a bind mount. The runner instead gives
# this account a readable snapshot containing only Git-tracked files.
# Lingering is enabled so the user manager survives the end of a login session,
# which is itself one of the cases.
RUN set -eux; \
    groupadd --system dolly; \
    useradd --gid dolly --create-home --shell /bin/bash dolly; \
    usermod --groups '' --lock dolly; \
    mkdir -p /var/lib/systemd/linger; \
    touch /var/lib/systemd/linger/dolly

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
