#!/bin/sh
# Install as /etc/letsencrypt/renewal-hooks/deploy/sidestream-telemetry-reload.
set -eu
case "${RENEWED_LINEAGE:-}" in
  /etc/letsencrypt/live/telemetry.sidestream.tv)
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
    ;;
esac
