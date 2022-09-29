#!/bin/sh

mkdir -p /data/android

exec /app/dist/cli/cli-entry.js --data-path /data "$@"
