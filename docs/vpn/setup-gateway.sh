#!/usr/bin/env bash
# One-time setup of the central WireGuard gateway for pve-panel.
# Run as root on a fresh Debian 12/13 VM that sits on your LAN bridge (vmbr0).
#
# Usage:  bash setup-gateway.sh <proxmox-host-lan-ip> [listen-port] [customer-prefix] [vpn-prefix]
# Example: bash setup-gateway.sh 192.168.1.105 51820 10.100 10.101
#
# Afterwards the panel manages the peers and firewall rules through the QEMU
# guest agent; there is no need to touch WireGuard on this VM again.

set -euo pipefail

PVE_HOST="${1:?Give the LAN IP of the Proxmox host, e.g. 192.168.1.105}"
PORT="${2:-51820}"
CUSTOMER_PREFIX="${3:-10.100}"
VPN_PREFIX="${4:-10.101}"

echo "==> Installing packages"
apt-get update -q
apt-get install -y -q wireguard-tools nftables qemu-guest-agent
systemctl enable --now qemu-guest-agent nftables

# Everything below creates secrets or files only root may read.
umask 077

echo "==> Server key"
install -d -m 700 /etc/wireguard
if [[ ! -s /etc/wireguard/server.key ]]; then
  wg genkey > /etc/wireguard/server.key
fi
SERVER_KEY="$(cat /etc/wireguard/server.key)"

echo "==> Files the panel manages (start empty: no devices, everything from wg0 blocked)"
echo "# Managed by pve-panel." > /etc/wireguard/panel-peers.conf

cat > /etc/wireguard/panel-rules.nft <<'RULES'
# Managed by pve-panel. Replaced on the first sync.
table inet panel_vpn
delete table inet panel_vpn
table inet panel_vpn {
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "wg0" drop
  }
  chain forward {
    type filter hook forward priority 0; policy accept;
    iifname "wg0" drop
    oifname "wg0" drop
  }
}
RULES

echo "==> wg0 interface"
cat > /etc/wireguard/wg0.conf <<WGCONF
[Interface]
Address = ${VPN_PREFIX}.0.1/16
ListenPort = ${PORT}
PrivateKey = ${SERVER_KEY}
# Customer networks live behind the Proxmox host
PostUp = ip route replace ${CUSTOMER_PREFIX}.0.0/16 via ${PVE_HOST}
PostUp = wg addconf %i /etc/wireguard/panel-peers.conf
PostUp = nft -f /etc/wireguard/panel-rules.nft
PreDown = ip route del ${CUSTOMER_PREFIX}.0.0/16 via ${PVE_HOST} || true
WGCONF

umask 022

echo "==> IP forwarding"
echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/90-pve-panel-vpn.conf
sysctl -q --system

systemctl enable wg-quick@wg0
systemctl restart wg-quick@wg0

echo
echo "Done. Gateway public key: $(wg show wg0 public-key)"
echo "Listening on UDP ${PORT}. Next steps (see the documentation: https://hawaianblue21.github.io/pve-panel):"
echo "  - on the Proxmox host: route ${VPN_PREFIX}.0.0/16 via this VM's LAN IP"
echo "  - on your router: forward UDP ${PORT} to this VM"
echo "  - in the panel's .env: VPN_ENABLED=true, VPN_GATEWAY_VMID, VPN_ENDPOINT"
