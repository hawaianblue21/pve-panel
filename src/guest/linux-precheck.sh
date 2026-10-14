# PVEPANEL-LU-PRECHECK
pm=none
if command -v apt-get >/dev/null 2>&1; then pm=apt; elif command -v dnf >/dev/null 2>&1; then pm=dnf; fi
free=$(df -Pm / | awk 'NR==2 {print $4}')
running=false
if [ -e /var/lib/pvepanel/update.lock ] && ! flock -n /var/lib/pvepanel/update.lock true 2>/dev/null; then running=true; fi
os=$( . /etc/os-release 2>/dev/null; printf '%s' "${PRETTY_NAME:-Linux}" | tr -d '"\\')
printf '{"pm":"%s","freeMb":%s,"running":%s,"os":"%s"}\n' "$pm" "${free:-0}" "$running" "$os"
