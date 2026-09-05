#!/bin/sh
set -eu
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/bmusic.ftwegc.com ]; then
    nginx -t && systemctl reload nginx
fi
