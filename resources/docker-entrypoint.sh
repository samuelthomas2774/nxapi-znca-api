#!/bin/sh

mkdir -p /data/android

exec /app/bin/nxapi-znca-api.js --data-path /data "$@"
