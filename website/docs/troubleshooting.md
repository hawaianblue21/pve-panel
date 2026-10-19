---
title: Troubleshooting
sidebar_position: 9
---

The **Activity** tab in the admin interface records the exact reason of most failures
(sign-ins, provisioning, deletions). Check it first.

## Guest agent errors

**"qga command 'guest-exec-status' failed - got timeout":** the guest agent in a
server didn't answer for a moment, which happens while the server is busy
(installers, heavy disk activity, Windows setup). The panel waits such stalls out
and only gives up after `AGENT_UNRESPONSIVE_SECONDS` (default 180) of silence. If
it does give up, check the server's load and that `qemu-guest-agent` is running,
then try again. Updating the agent (virtio-win ISO on Windows) helps with
recurring stalls.

**"Agent error: PID lld does not exist":** the guest agent reports a finished
command only once; if that answer arrived late, the agent has already forgotten the
process ("lld" is a formatting bug in the Windows agent's message). The command
did run. The panel now handles this: commands that are safe to repeat are run once
more, and one-shot steps (`tailscale up`, `tailscale logout`) are never repeated;
instead the panel checks whether Tailscale is really connected or disconnected.

## Topic-specific troubleshooting

| Problem | Where |
|---|---|
| Servers get no IP address, isolation or outgoing block doesn't work | [Customer networks](networking/customer-networks.md) |
| VPN device doesn't connect | [WireGuard VPN](networking/wireguard-vpn.md) |
| Windows server stops at the welcome screens, template issues | [Templates](guides/templates.md) |
| Single sign-on fails ("couldn't be completed in this browser", "unavailable") | [Single sign-on](security/single-sign-on.md) |
| 2FA codes rejected | [Two-factor authentication](security/two-factor.md) — check the host clock |
| Portainer container starts without settings | [Prebuilt image and Portainer](installation/prebuilt-image.md) |
| A customer can't be deleted | [Servers and customers](administration/servers-and-customers.md) |
| Invitation emails aren't sent | [Email and invitations](administration/email-invitations.md) — use *Send test email* |
| About shows a development build | [Versions, releases and updates](administration/updates.md) |

## Reporting a problem

Open an issue at [github.com/hawaianblue21/pve-panel/issues](https://github.com/hawaianblue21/pve-panel/issues)
with the Proxmox VE version, deployment method, PVE Panel version (admin → **About**),
relevant logs and the exact error. Never include tokens, passwords or secrets.
