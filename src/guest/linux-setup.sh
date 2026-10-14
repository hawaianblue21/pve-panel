# PVEPANEL-LU-SETUP
set -e
mkdir -p /var/lib/pvepanel && chmod 700 /var/lib/pvepanel
cat > /var/lib/pvepanel/update.sh
chmod 700 /var/lib/pvepanel/update.sh
rm -f /var/lib/pvepanel/update-status.json
if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemd-run --unit="pvepanel-update-${1:0:8}" --collect --quiet /bin/bash /var/lib/pvepanel/update.sh "$1" "$2" "$3"
else
  setsid nohup /bin/bash /var/lib/pvepanel/update.sh "$1" "$2" "$3" >/dev/null 2>&1 < /dev/null &
fi
echo started
