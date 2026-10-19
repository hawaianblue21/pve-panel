---
title: Quick start
sidebar_position: 1
---

The fastest way to run PVE Panel is the prebuilt container image with Docker Compose.

## 1. Prepare Proxmox

Create the service account, role, pool and API token as described in
[Prepare Proxmox VE](../installation/proxmox.md). You need the token ID and secret.

## 2. Create a folder with two files

```bash
mkdir pve-panel && cd pve-panel
curl -LO https://raw.githubusercontent.com/hawaianblue21/pve-panel/main/deploy/docker-compose.yml
curl -L -o .env https://raw.githubusercontent.com/hawaianblue21/pve-panel/main/example.env
```

Edit `.env` and set at least:

```ini
PVE_URL=https://pve.example.com:8006
PVE_TOKEN_ID=panel@pve!panel
PVE_TOKEN_SECRET=your-token-secret
JWT_SECRET=replace-with-a-long-random-secret

# first administrator, created on the first start
INITIAL_ADMIN_EMAIL=admin@example.com
INITIAL_ADMIN_PASSWORD=a-long-password

# only while testing over plain http
COOKIE_SECURE=false
```

## 3. Start

```bash
docker compose up -d
```

After about 20 seconds `docker compose ps` shows the container as **healthy**.

## 4. Sign in

| Interface | Address |
|---|---|
| Customer portal | `http://<host>:3000` |
| Admin interface | `http://127.0.0.1:3001` on the Docker host — from your PC via `ssh -L 3001:127.0.0.1:3001 you@host` |

Sign in to the admin interface with the initial administrator, then remove
`INITIAL_ADMIN_PASSWORD` from `.env`.

## Next steps

- Add customers and assign servers: [Servers and customers](../administration/servers-and-customers.md)
- Offer templates for self-service: [Linux and Windows templates](../guides/templates.md)
- Isolated networks per customer: [Customer networks](../networking/customer-networks.md)
- Production: [HTTPS and reverse proxy](../installation/reverse-proxy.md), `COOKIE_SECURE=true`
- Using Portainer or a NAS: [Prebuilt image and Portainer](../installation/prebuilt-image.md), [UGREEN NAS](../installation/ugreen-nas.md)
