#!/usr/bin/env bash
# Prints the running proxy container's access token (for chrome:smoke). Nothing is stored.
exec docker inspect assistant-chrome-guardproxy-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^ACCESS_TOKEN=//p' | head -n 1
