# GitHub Actions auto-deploy to Alibaba Cloud

This repo contains `.github/workflows/deploy-alibaba.yml`.

The workflow runs CI first, then:

- deploys the Django backend to an Alibaba Cloud ECS or Simple Application Server over SSH and restarts `systemd`;
- builds the Vite web app with production `VITE_*` values and uploads `apps/web/dist/` to OSS using Alibaba Cloud `ossutil 2.0`.

Official docs used:

- GitHub recommends `actions/setup-node` for consistent Node.js setup in Actions: https://docs.github.com/actions/guides/building-and-testing-nodejs
- Alibaba Cloud recommends `ossutil 2.0` for new OSS automation, with Linux install packages and environment variable configuration: https://www.alibabacloud.com/help/en/oss/developer-reference/ossutil-overview/
- Alibaba Cloud documents `ossutil sync file_url cloud_url` for local-to-OSS uploads: https://www.alibabacloud.com/help/en/oss/developer-reference/synchronize-local-files-to-oss

## What runs automatically

On every push to `main`:

1. `npm ci`
2. `npm run typecheck:web`
3. `npm run test:web`
4. `npm run build:web`
5. `uv python install 3.12`
6. `uv run --frozen python manage.py check`
7. `uv run --frozen pytest`
8. backend deploy over SSH
9. web deploy to OSS

You can also run it manually from GitHub Actions with `workflow_dispatch` and choose backend only, web only, or both.

## GitHub repository settings

Create a `production` environment in GitHub:

1. Go to `Settings` -> `Environments`.
2. Create `production`.
3. Add required reviewers if you want deploy approval before production changes.

Add these repository or environment secrets.

Backend SSH secrets:

| Secret | Example | Notes |
|---|---|---|
| `ALIBABA_BACKEND_HOST` | `47.88.x.x` or `api.example.com` | Public IP or hostname of the backend server. |
| `ALIBABA_BACKEND_SSH_USER` | `deploy` | Linux user GitHub Actions will SSH as. |
| `ALIBABA_BACKEND_SSH_KEY` | private key text | Private key matching the deploy user's `authorized_keys`. |
| `ALIBABA_BACKEND_SSH_PORT` | `22` | Optional; defaults to `22`. |
| `ALIBABA_BACKEND_APP_DIR` | `/opt/describeops` | Optional; defaults to `/opt/describeops`. |
| `ALIBABA_BACKEND_SERVICE` | `describeops` | Optional; defaults to `describeops`. |
| `ALIBABA_BACKEND_HEALTH_URL` | `https://api.example.com/health` | Optional post-deploy health check. |

Web and OSS secrets:

| Secret | Example | Notes |
|---|---|---|
| `VITE_API_BASE_URL` | `https://api.example.com` | Baked into the production web build. |
| `VITE_API_TOKEN` | same as backend `DESCRIBEOPS_API_TOKEN` | Baked into the production web build. |
| `ALIBABA_OSS_ACCESS_KEY_ID` | `LTAI...` | RAM user AccessKey ID. |
| `ALIBABA_OSS_ACCESS_KEY_SECRET` | `...` | RAM user AccessKey secret. |
| `ALIBABA_OSS_REGION` | `ap-southeast-1` | OSS bucket region ID. |
| `ALIBABA_OSS_ENDPOINT` | `https://oss-ap-southeast-1.aliyuncs.com` | Public OSS endpoint for the bucket region. |
| `ALIBABA_OSS_BUCKET` | `describeops-web-prod` | OSS bucket name. |
| `ALIBABA_OSS_PREFIX` | empty or `web` | Optional folder prefix inside the bucket. |

## Alibaba Cloud RAM setup

Create a dedicated RAM user for GitHub Actions. Do not use your root Alibaba Cloud account keys.

Grant the RAM user the minimum OSS permissions for the web bucket:

- `oss:ListObjects`
- `oss:PutObject`

If you enable `delete_stale_web_assets` in the manual workflow run, also grant:

- `oss:DeleteObject`

Alibaba Cloud's OSS sync docs recommend enabling bucket versioning before using `--delete`, because it removes destination objects that are not present in the source build.

## Server setup required before first deploy

Provision the backend server using [alibaba-cloud.md](/home/devnexx/Nexxyu/projects/accessibility/docs/deployment/alibaba-cloud.md), then do these CI/CD-specific steps.

Create a deploy user:

```bash
sudo useradd --create-home --shell /bin/bash deploy
sudo mkdir -p /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
sudo touch /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh
```

Generate an SSH key locally or in a secure admin machine:

```bash
ssh-keygen -t ed25519 -C "github-actions-describeops-prod" -f github-actions-describeops-prod
```

Add the public key to the server:

```bash
cat github-actions-describeops-prod.pub | ssh root@api.example.com 'cat >> /home/deploy/.ssh/authorized_keys'
```

Add the private key contents to GitHub as `ALIBABA_BACKEND_SSH_KEY`.

Allow the deploy user to update the app directory:

```bash
sudo mkdir -p /opt/describeops
sudo chown -R deploy:deploy /opt/describeops
```

Keep runtime-owned media writable:

```bash
sudo mkdir -p /var/lib/describeops/media
sudo chown -R describeops:describeops /var/lib/describeops
```

Install server tools:

```bash
sudo apt-get update
sudo apt-get install -y rsync nginx git ffmpeg python3.12 python3.12-venv
curl -LsSf https://astral.sh/uv/install.sh | sh
sudo ln -s "$HOME/.local/bin/uv" /usr/local/bin/uv
```

Create `/opt/describeops/backend/.env` manually on the server. Use [backend/.env.production.example](/home/devnexx/Nexxyu/projects/accessibility/backend/.env.production.example) as the template. The workflow intentionally does not upload `.env`.

Install the systemd and Nginx files once:

```bash
sudo cp /opt/describeops/deploy/alibaba/describeops.service /etc/systemd/system/describeops.service
sudo cp /opt/describeops/deploy/alibaba/nginx-describeops.conf /etc/nginx/sites-available/describeops.conf
sudo ln -s /etc/nginx/sites-available/describeops.conf /etc/nginx/sites-enabled/describeops.conf
sudo nginx -t
sudo systemctl daemon-reload
```

Allow the deploy user to restart and inspect only the backend service:

```bash
command -v systemctl
sudo visudo -f /etc/sudoers.d/describeops-deploy
```

Add the matching `systemctl` path from `command -v systemctl`. On many Ubuntu images this is `/usr/bin/systemctl`; on some distributions `/bin/systemctl` is a symlink.

```text
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart describeops, /usr/bin/systemctl status describeops, /usr/bin/systemctl --no-pager --full status describeops
```

Run the first manual backend setup after the app files exist:

```bash
cd /opt/describeops/backend
uv sync --frozen --no-dev
uv run python manage.py migrate --noinput
uv run python manage.py collectstatic --noinput
sudo systemctl enable --now describeops
```

## OSS setup required before first web deploy

In the OSS bucket:

1. Enable static website hosting.
2. Set index document to `index.html`.
3. Set error document to `index.html`.
4. Bind your custom domain or CDN domain.
5. Configure HTTPS for that domain.

The workflow uses:

```bash
ossutil sync apps/web/dist/ oss://bucket/prefix/ -f
```

It does not delete stale OSS objects on normal `main` pushes. Manual runs can enable `delete_stale_web_assets`; do that only after bucket versioning is enabled and the prefix is correct.

## First deployment checklist

1. Merge the workflow to `main`.
2. Confirm all GitHub secrets are present in the `production` environment.
3. Confirm `/opt/describeops/backend/.env` exists on the server.
4. Confirm the deploy user can SSH in:

```bash
ssh deploy@api.example.com 'whoami && command -v uv && sudo systemctl status describeops --no-pager'
```

5. Run the workflow manually from GitHub Actions.
6. Check backend health:

```bash
curl -i https://api.example.com/health
```

7. Open the OSS/custom-domain web URL and confirm it calls `VITE_API_BASE_URL`.
