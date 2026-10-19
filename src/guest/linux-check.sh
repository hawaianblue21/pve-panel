# PVEPANEL-LU-CHECK
# Counts pending package updates (all, and security) without installing anything.
# Prints one JSON line. Refreshing the package lists is the only change it makes.
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
reboot=false
[ -e /var/run/reboot-required ] && reboot=true
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq >/dev/null 2>&1 || true
  sim=$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | grep '^Inst ')
  total=$(printf '%s\n' "$sim" | grep -c '^Inst ')
  security=$(printf '%s\n' "$sim" | grep -c -- '-security')
  pm=apt
elif command -v dnf >/dev/null 2>&1; then
  total=$(dnf -q check-update --refresh 2>/dev/null | awk 'NF==3 && $1 ~ /\./ {n++} END {print n+0}')
  security=$(dnf -q updateinfo list --security --available 2>/dev/null | awk 'NF>=3 {n++} END {print n+0}')
  command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1 && reboot=true
  pm=dnf
else
  printf '{"pm":"none"}\n'
  exit 0
fi
printf '{"pm":"%s","pending":%s,"security":%s,"rebootRequired":%s}\n' "$pm" "${total:-0}" "${security:-0}" "$reboot"
