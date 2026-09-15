#!/bin/sh
# Install as /etc/letsencrypt/renewal-hooks/deploy/alexg-reload.
set -eu
case "${RENEWED_LINEAGE:-}" in
  /etc/letsencrypt/live/alexg.mov)
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
    ;;
esac
