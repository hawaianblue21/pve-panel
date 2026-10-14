#!/bin/bash
# PVE Panel: Linux package updates (started by the panel through the QEMU guest agent)
set -u
DIR=${PVEPANEL_DIR:-/var/lib/pvepanel}
STATUS=$DIR/update-status.json
RUN_ID="$1"; SCOPE="$2"; AUTO="$3"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 LC_ALL=C
TOTAL=0; CURRENT=0; REBOOT=false; PM=none
NAMES=(); DETAILS=(); FRESH=()

exec 9>"$DIR/update.lock"
flock -n 9 || exit 0      # another run is active

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'; }
save() { # state message [error-json]
  local items="" sep="" i
  for i in "${!NAMES[@]}"; do
    items="$items$sep{\"kb\":\"$(esc "${NAMES[$i]}")\",\"title\":\"$(esc "${DETAILS[$i]}")\"}"; sep=","
  done
  printf '{"runId":"%s","state":"%s","message":"%s","error":%s,"total":%d,"current":%d,"installed":[%s],"failed":[],"rebootRequired":%s,"manager":"%s","updatedAt":"%s"}\n' \
    "$RUN_ID" "$1" "$(esc "$2")" "${3:-null}" "$TOTAL" "$CURRENT" "$items" "$REBOOT" "$PM" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS.tmp"
  mv -f "$STATUS.tmp" "$STATUS"
}
fail() { NAMES=(); DETAILS=(); save failed "Package update failed" "\"$(esc "$1")\""; exit 1; }
lastlines() { tail -n 4 "$1" 2>/dev/null | tr '\n' ' ' | cut -c1-400; }

reboot_needed() {
  [ -f /var/run/reboot-required ] && return 0
  if command -v needs-restarting >/dev/null 2>&1; then
    needs-restarting -r >/dev/null 2>&1; [ $? -eq 1 ] && return 0
  fi
  local newest
  newest=$(ls -1 /boot/vmlinuz-* 2>/dev/null | sed 's|^/boot/vmlinuz-||' | grep -v rescue | sort -V | tail -n 1)
  [ -n "$newest" ] && [ "$newest" != "$(uname -r)" ] && return 0
  return 1
}

# Runs the installer in the background and reports "n of total" from its log.
run_counted() { # log pattern command...
  local log="$1" pattern="$2" pid rc n; shift 2
  "$@" >"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    n=$(grep -cE "$pattern" "$log" 2>/dev/null); n=${n:-0}
    [ "$n" -gt "$TOTAL" ] && n=$TOTAL
    CURRENT=$n; save installing "Installing $CURRENT of $TOTAL packages"
    sleep 3
  done
  wait "$pid"; rc=$?
  return $rc
}

if command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf >/dev/null 2>&1; then PM=dnf
else fail "No supported package manager (apt or dnf) found"
fi

if [ "$PM" = apt ]; then
  save searching "Refreshing the package lists"
  apt-get -q -o DPkg::Lock::Timeout=600 update >"$DIR/apt-update.log" 2>&1 \
    || fail "apt-get update failed: $(lastlines "$DIR/apt-update.log")"
  HELD=" $(apt-mark showhold 2>/dev/null | tr '\n' ' ') "
  AUTO_BEFORE=" $(apt-mark showauto 2>/dev/null | tr '\n' ' ') "
  # "Inst name [old-version] (new-version archive [arch])"
  while read -r _ name rest; do
    [ -z "${name:-}" ] && continue
    case "$HELD" in *" $name "*) continue ;; esac
    if [ "$SCOPE" = security ] && ! printf '%s' "$rest" | grep -qi 'security'; then continue; fi
    old=$(printf '%s' "$rest" | sed -n 's/^\[\([^]]*\)\].*/\1/p')
    new=$(printf '%s' "$rest" | sed -n 's/^[^(]*(\([^ )]*\).*/\1/p')
    NAMES+=("$name"); DETAILS+=("${old:+$old → }$new")
    [ -z "$old" ] && FRESH+=("$name")
  done < <(apt-get -s -o Debug::NoLocking=1 upgrade --with-new-pkgs 2>/dev/null | grep '^Inst ')
  TOTAL=${#NAMES[@]}
  if [ "$TOTAL" -eq 0 ]; then save done "The server is up to date"; exit 0; fi
  OPTS=(-y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
  if [ "$SCOPE" = security ]; then
    run_counted "$DIR/apt.log" '^Setting up ' apt-get "${OPTS[@]}" install "${NAMES[@]}" \
      || fail "apt-get exited with an error: $(lastlines "$DIR/apt.log")"
    # "apt-get install" marks packages as manually installed; keep the marks a
    # normal upgrade would leave (new dependencies such as a new kernel: automatic)
    KEEP_AUTO=(${FRESH[@]+"${FRESH[@]}"})
    for n in "${NAMES[@]}"; do case "$AUTO_BEFORE" in *" $n "*) KEEP_AUTO+=("$n") ;; esac; done
    if [ ${#KEEP_AUTO[@]} -gt 0 ]; then apt-mark auto "${KEEP_AUTO[@]}" >/dev/null 2>&1 || true; fi
  else
    run_counted "$DIR/apt.log" '^Setting up ' apt-get "${OPTS[@]}" upgrade --with-new-pkgs \
      || fail "apt-get exited with an error: $(lastlines "$DIR/apt.log")"
  fi
else
  save searching "Checking for updates"
  if [ "$SCOPE" = security ]; then FLAGS=(--security); else FLAGS=(); fi
  dnf -q ${FLAGS[@]+"${FLAGS[@]}"} check-update >"$DIR/dnf-check.log" 2>&1; rc=$?
  [ $rc -ne 0 ] && [ $rc -ne 100 ] && fail "dnf check-update failed: $(lastlines "$DIR/dnf-check.log")"
  # "name.arch  version  repository"
  while read -r pkg ver repo; do
    NAMES+=("${pkg%.*}"); DETAILS+=("$ver ($repo)")
  done < <(awk 'NF==3 && $1 ~ /\./ && $2 ~ /[0-9]/ && $3 !~ /^@/ {print $1, $2, $3}' "$DIR/dnf-check.log")
  TOTAL=${#NAMES[@]}
  if [ "$TOTAL" -eq 0 ]; then save done "The server is up to date"; exit 0; fi
  run_counted "$DIR/dnf.log" '^[[:space:]]+(Upgrading|Installing)[[:space:]]+:' dnf -y ${FLAGS[@]+"${FLAGS[@]}"} upgrade \
    || fail "dnf exited with an error: $(lastlines "$DIR/dnf.log")"
fi

CURRENT=$TOTAL
if reboot_needed; then
  REBOOT=true
  if [ "$AUTO" = 1 ]; then
    save done "Updates installed. Restarting in 1 minute to load the new kernel"
    shutdown -r +1 "PVE Panel: restart after updates" >/dev/null 2>&1 || systemctl reboot
    exit 0
  fi
  save done "Updates installed. Restart the server to finish (new kernel or system libraries)"
else
  save done "Updates installed"
fi
