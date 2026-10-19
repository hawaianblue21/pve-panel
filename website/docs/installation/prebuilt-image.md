---
title: Prebuilt image and Portainer
sidebar_position: 3
---

Instead of building on the server or NAS, let GitHub build the image and
download the finished image from the GitHub Container Registry (`ghcr.io`). The
workflow `.github/workflows/docker-publish.yml` builds for amd64 and arm64 on
every push to `main` and every release tag, and publishes the image with an SBOM
and signed build provenance. Pull requests only build (as a test).

1. **Create a repository** on GitHub and push the project:
   ```bash
   git init && git add . && git commit -m "Initial version"
   git branch -M main
   git remote add origin https://github.com/hawaianblue21/pve-panel.git
   git push -u origin main
   ```
   `.gitignore` keeps `.env`, the database and `node_modules` out of the repository;
   no secrets go to GitHub, and none are in the image.
2. **Watch it build** in the repository's **Actions** tab (the first run takes a
   few minutes; the arm64 part is emulated). The image then appears under
   **Packages** as `ghcr.io/hawaianblue21/pve-panel`.
3. **Releases:** see [Versions, releases and updates](../administration/updates.md) (`npm version`, then
   `git push --follow-tags`).
4. **Who may download it:**
   - *Public package:* anyone can pull it, no login needed on the NAS. Set it under
     the package's **Package settings, Change visibility**. The image contains
     code only, no configuration.
   - *Private package* (default for a private repository): log the NAS in once with
     a GitHub personal access token (classic) that only has `read:packages`:
     `sudo docker login ghcr.io -u hawaianblue21` over SSH, token as password.
5. **On the server or NAS** you only need two files in one folder: 
   `deploy/docker-compose.yml` (saved there as `docker-compose.yml`) and your
   `.env` with, among the usual settings,
   `PANEL_IMAGE` only if you want to pin a release (e.g.
   `ghcr.io/hawaianblue21/pve-panel:1.0.0`); the default is `ghcr.io/hawaianblue21/pve-panel:latest`. Then create the Docker Project there, or run
   `docker compose up -d`.
6. **Updating:** push changes (or a new tag), wait for the Actions run, then
   redeploy the project; `pull_policy: always` fetches the new image. With a
   pinned release, change the version at the end of `PANEL_IMAGE` first.

**With Portainer:** use `deploy/docker-compose.portainer.yml` instead (Stacks, Add
stack, Web editor) and enter your settings under **Environment variables**, or
load your `.env` there. Portainer uses those variables only to fill in `${...}`
in the compose file and saves them to `stack.env`; the Portainer version passes
that file into the container (`env_file: stack.env`). With `env_file: .env` the
container starts without your settings and stops with
"Missing required environment variable JWT_SECRET".

Optional: verify an image came from your workflow with
`gh attestation verify oci://ghcr.io/hawaianblue21/pve-panel:latest --owner hawaianblue21`.
Dependabot (`.github/dependabot.yml`) proposes weekly updates for npm packages,
the Node base image and the workflow's actions.
