# Alibaba Cloud deployment guide

Prepared on 2026-06-23 against the current DescribeOps stack:

- Backend: Django 5.2 + Django Ninja, Python 3.12, Gunicorn, DashScope/Qwen.
- Web app: Vite React static build.
- Runtime data: PostgreSQL recommended for production, media/frame files under `DESCRIBEOPS_MEDIA_ROOT`.

## Current Alibaba Cloud docs checked

- ECS getting started: https://www.alibabacloud.com/help/en/ecs/quick-start
- Create ECS instances with the wizard: https://www.alibabacloud.com/help/en/ecs/user-guide/create-an-instance-by-using-the-wizard
- Simple Application Server getting started, last updated 2026-05-27: https://www.alibabacloud.com/help/en/simple-application-server/getting-started/getting-started
- OSS static website hosting, last updated 2026-03-20: https://www.alibabacloud.com/help/en/oss/user-guide/hosting-static-websites
- OSS `website` CLI command, last updated 2026-03-20: https://www.alibabacloud.com/help/en/oss/developer-reference/website
- ACK user guide, last updated 2026-06-15: https://www.alibabacloud.com/help/en/ack/user-guide/
- ACK overview, last updated 2026-03-26: https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/getting-started/getting-started-overview
- Function Compute HTTP handlers, last updated 2026-03-31: https://www.alibabacloud.com/help/en/fc/http-handlers-1
- SSL certificate deployment to ECS, last updated 2026-03-20: https://www.alibabacloud.com/help/en/ssl-certificate/manually-deploy-certificates-to-alibaba-cloud-lightweight-application-servers-or-ecs-instances
- End-to-end website build flow, last updated 2026-03-10: https://www.alibabacloud.com/help/en/dws/getting-started/the-whole-process-of-website-building/

## Recommended first deployment

Use a small ECS instance or Simple Application Server for the backend, ApsaraDB RDS for PostgreSQL for the database, and OSS static website hosting for the Vite web app.

This avoids Kubernetes overhead while matching the app's current operational shape: long-running Django API requests, yt-dlp/FFmpeg-style media processing, local media artifacts, and a static browser app that only needs `VITE_API_BASE_URL`.

## Alibaba Cloud resources

Create these in one region:

- VPC and security group.
- ECS or Simple Application Server running Ubuntu 22.04 or Alibaba Cloud Linux 3.
- Public inbound ports: `80` and `443`; optionally `22` from your IP only.
- RDS PostgreSQL instance, private to the VPC.
- OSS bucket for the web app, with static website hosting enabled.
- Domain records:
  - `api.example.com` -> ECS public IP or ALB.
  - `www.example.com` -> OSS website endpoint or CDN custom domain.
- SSL certificates for both hostnames.

## Backend server setup

Install system packages:

```bash
sudo apt-get update
sudo apt-get install -y nginx git ffmpeg python3.12 python3.12-venv
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Create the app user and directories:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin describeops
sudo mkdir -p /opt/describeops /var/lib/describeops/media
sudo chown -R describeops:describeops /opt/describeops /var/lib/describeops
```

Deploy the repo to `/opt/describeops`, then from `/opt/describeops/backend`:

```bash
uv sync --frozen
cp .env.production.example .env
python - <<'PY'
from django.core.management.utils import get_random_secret_key
print(get_random_secret_key())
PY
```

Edit `.env` with the real domain names, RDS PostgreSQL URL, DashScope key, and shared API token.

Run database and static setup:

```bash
uv run python manage.py check --deploy
uv run python manage.py migrate
uv run python manage.py collectstatic --noinput
uv run python manage.py qwen_smoke
```

Install service and Nginx config:

```bash
sudo cp /opt/describeops/deploy/alibaba/describeops.service /etc/systemd/system/describeops.service
sudo cp /opt/describeops/deploy/alibaba/nginx-describeops.conf /etc/nginx/sites-available/describeops.conf
sudo ln -s /etc/nginx/sites-available/describeops.conf /etc/nginx/sites-enabled/describeops.conf
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now describeops
sudo systemctl reload nginx
```

After DNS is pointed at the server, install the SSL certificate through Alibaba Cloud Certificate Management Service or your preferred ACME flow, then redirect HTTP to HTTPS.

## Web app build and OSS upload

Build with the production backend URL:

```bash
cd /opt/describeops
cp apps/web/.env.production.example apps/web/.env.production
npm ci
npm run build:web
```

Upload `apps/web/dist/` to the OSS bucket. In OSS static website hosting:

- Index document: `index.html`
- Error document: `index.html`

Using `index.html` for both lets the Vite client-side router handle review and processing routes.

Set the backend environment so CORS allows the web origin:

```text
DESCRIBEOPS_ALLOWED_ORIGINS=https://www.example.com,https://example.com
```

Then restart:

```bash
sudo systemctl restart describeops
```

## Verification

Backend:

```bash
curl -i https://api.example.com/health
curl -i -H "X-DescribeOps-Token: $DESCRIBEOPS_API_TOKEN" https://api.example.com/api/v1/sessions
sudo journalctl -u describeops -n 100 --no-pager
```

Web:

- Open `https://www.example.com`.
- Submit a small public video URL.
- Confirm the browser network tab calls `https://api.example.com`.
- Confirm artifacts appear in the review/export view.

## Production notes

- Do not use SQLite in production. Use RDS PostgreSQL through `DATABASE_URL`.
- Keep `DJANGO_DEBUG=0`.
- Set `DJANGO_ALLOWED_HOSTS` to the API hostname and any load balancer hostnames.
- Set `DJANGO_CSRF_TRUSTED_ORIGINS` to the HTTPS API origin.
- Keep `DJANGO_SECURE_SSL_REDIRECT=1` after HTTPS is installed. If HTTPS redirection is handled only at a load balancer, leave this as `0` and enforce the redirect there.
- Keep `DESCRIBEOPS_API_TOKEN` identical in backend `.env` and web build env.
- `DESCRIBEOPS_MEDIA_ROOT` should be on durable disk or migrated to OSS-backed storage before scaling beyond one backend node.
- Use CloudMonitor alerts for CPU, memory, disk, HTTP 5xx, and RDS connections.
- Put slow media processing behind a task queue before running multiple workers or high traffic.

## Later deployment paths

ACK is the right next step once the backend is containerized, media storage is moved out of local disk, and background jobs are separated from request handling. Alibaba Cloud's ACK docs currently emphasize console or `kubectl` deployment, Helm, autoscaling, canary release, and integration with other Alibaba Cloud services.

Function Compute can run HTTP workloads and supports Python WSGI-style HTTP handlers, but this app currently has long media-processing requests and local media artifacts. Treat Function Compute as a later refactor target, not the first production deployment.
