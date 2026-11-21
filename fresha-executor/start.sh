#!/bin/sh
set -eu
umask 077
mkdir -p /data/NovaBrain/FreshaExecutor
chown -R node:node /data/NovaBrain
chmod 700 /data/NovaBrain /data/NovaBrain/FreshaExecutor
Xvfb :99 -screen 0 1280x850x24 -nolisten tcp &
count=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  count=$((count + 1)); [ "$count" -lt 20 ] || exit 1
  sleep 0.25
done
# No public HTTP service, VNC port or browser debugging port. Temporary owner
# login is available only through a separately opened Fly private-network tunnel.
if [ "${FRESHA_OWNER_LOGIN_ENABLED:-false}" = "true" ]; then
  test -n "${FRESHA_VNC_PASSWORD:-}"
  x11vnc -storepasswd "$FRESHA_VNC_PASSWORD" /tmp/fresha_vnc_password >/dev/null 2>&1
  chmod 600 /tmp/fresha_vnc_password
  x11vnc -display :99 -localhost -rfbauth /tmp/fresha_vnc_password -forever -shared -quiet -o /dev/null &
  websockify --web=/usr/share/novnc [::]:6080 127.0.0.1:5900 >/dev/null 2>&1 &
fi
exec runuser -u node -- node /app/fresha-executor/server.js
