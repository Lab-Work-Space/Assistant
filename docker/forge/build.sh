#!/usr/bin/env bash
# Owner step (PF-C23): builds the forge base image from docker/forge/base.Dockerfile and writes its id to docker/forge/images.json ({"base":"sha256:<64hex>"}).
# Only this script writes images.json; the app reads it once at boot and checks it against the image id. Needs network (the Node base is pulled here, never by the app).
set -euo pipefail
cd "$(dirname "$0")/../.."
id=$(docker build -q -f docker/forge/base.Dockerfile -t assistant-forge-base:local .)
case "$id" in sha256:[0-9a-f][0-9a-f]*) ;; *) echo "unexpected image id: $id" >&2; exit 1 ;; esac
printf '{"base":"%s"}\n' "$id" > docker/forge/images.json
echo "base=$id"
