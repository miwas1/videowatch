# Deploy DescribeOps to Alibaba Cloud ECS

This is the single production deployment path for DescribeOps. One Alibaba Cloud ECS instance runs the web app, HTTPS edge, and Django API with Docker Compose. Neon provides managed PostgreSQL, so no database container or Alibaba RDS instance is required.

The stack contains:

- `web`: the Vite React build served by Caddy. Caddy also obtains and renews HTTPS certificates.
- `backend`: Django API served by Gunicorn.
- `worker`: Django media-processing worker that runs FFmpeg, yt-dlp, Qwen analysis, and artifact synthesis jobs from the database-backed queue.
- Docker volumes for generated media, Django static files, and Caddy certificates.
- Neon PostgreSQL over an encrypted external connection.

## 1. Create the cloud resources

Create an Ubuntu 24.04 ECS instance with enough disk for generated media. A small instance is sufficient for an initial deployment, but video processing benefits from additional CPU and memory.

Configure its security group:

| Port | Source | Purpose |
|---|---|---|
| `22/tcp` | Your IP and GitHub Actions runner access | Deployment SSH |
| `80/tcp` | Internet | HTTPS certificate issuance and redirect |
| `443/tcp` | Internet | Web application and API |
| `443/udp` | Internet | Optional HTTP/3 |

Create a DNS `A` record such as `describeops.example.com` pointing to the ECS public IP. DNS must resolve before Caddy can issue the certificate.

Create a Neon project and copy its **pooled** connection string. Keep `sslmode=require` and `channel_binding=require` in the URL.

## 2. Prepare ECS once

Connect to the instance and install Docker:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 rsync
sudo systemctl enable --now docker
```

Create a deployment user and application directory:

```bash
sudo useradd --create-home --shell /bin/bash deploy
sudo usermod -aG docker deploy
sudo mkdir -p /opt/describeops /home/deploy/.ssh
sudo touch /home/deploy/.ssh/authorized_keys
sudo chmod 700 /home/deploy/.ssh
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo chown -R deploy:deploy /home/deploy/.ssh /opt/describeops
```

Generate a deployment key on a trusted machine:

```bash
ssh-keygen -t ed25519 -C "github-actions-describeops" -f describeops-ecs
```

Append `describeops-ecs.pub` to `/home/deploy/.ssh/authorized_keys` on ECS. Reconnect as `deploy` after adding it to the Docker group, then confirm:

```bash
ssh deploy@YOUR_ECS_IP 'docker compose version'
```

## 3. Create the production environment

From your local repository, upload the environment template before the first workflow run:

```bash
scp .env.production.example deploy@YOUR_ECS_IP:/opt/describeops/.env
```

Then connect to ECS and protect the only server-side configuration file:

```bash
cd /opt/describeops
chmod 600 .env
nano .env
```

Edit `.env` and set at minimum:

- `DOMAIN` and `ACME_EMAIL`.
- `DJANGO_SECRET_KEY`; generate a long random value.
- `DJANGO_ALLOWED_HOSTS`, `DJANGO_CSRF_TRUSTED_ORIGINS`, and `DESCRIBEOPS_ALLOWED_ORIGINS` for the same public domain.
- `DATABASE_URL` to the pooled Neon URL.
- `DASHSCOPE_API_KEY`.
- `DESCRIBEOPS_API_TOKEN` as a long random service token for trusted extension/admin ingestion calls.
- `VITE_API_TOKEN` should stay blank for the public web app. Browser users now sign in and receive per-account API tokens at runtime.
- Optional `DESCRIBEOPS_SECRETS_DIR=./secrets` and `DESCRIBEOPS_YTDLP_COOKIE_FILE=/app/secrets/youtube-cookies.txt` when you need the backend to ingest YouTube or social videos you own or are authorized to access.

`VITE_API_TOKEN` is compiled into browser JavaScript. Do not put the service token there for a product deployment.

For cookie-backed URL ingestion, create the secrets directory on ECS and place a Netscape-format cookies export there:

```bash
cd /opt/describeops
mkdir -p secrets
chmod 700 secrets
# Upload or create secrets/youtube-cookies.txt, then:
chmod 600 secrets/youtube-cookies.txt
```

The file is mounted read-only into the backend container at `/app/secrets/youtube-cookies.txt`. Keep it out of git and rotate it if the browser account changes password or signs out.

To export cookies from a browser session on your local machine, first sign in to YouTube in that browser, then run:

```bash
./scripts/export-youtube-cookies.sh chrome
```

You can replace `chrome` with another yt-dlp supported browser name, such as `firefox`, `edge`, or `chromium`. Then copy the generated file to ECS:

```bash
ssh deploy@YOUR_ECS_IP 'mkdir -p /opt/describeops/secrets && chmod 700 /opt/describeops/secrets'
scp secrets/youtube-cookies.txt deploy@YOUR_ECS_IP:/opt/describeops/secrets/youtube-cookies.txt
ssh deploy@YOUR_ECS_IP 'chmod 600 /opt/describeops/secrets/youtube-cookies.txt && cd /opt/describeops && docker compose --env-file .env up -d --build'
```

## 4. Start manually

The whole application starts with:

```bash
cd /opt/describeops
docker compose --env-file .env up -d --build
docker compose ps
```

The backend container automatically runs migrations and `collectstatic` before starting Gunicorn. The worker container runs `python manage.py runworker` and consumes queued URL, upload, extension chunk, and synthesis jobs. Verify the public endpoint:

```bash
curl -fsS https://describeops.example.com/health
```

## 5. Enable GitHub Actions deployment

Create a GitHub `production` environment and add these secrets:

| Secret | Required | Example |
|---|---|---|
| `ECS_HOST` | Yes | `47.88.x.x` |
| `ECS_SSH_USER` | Yes | `deploy` |
| `ECS_SSH_KEY` | Yes | Contents of `describeops-ecs` private key |
| `ECS_SSH_PORT` | No | `22` |
| `ECS_APP_DIR` | No | `/opt/describeops` |
| `DEPLOY_HEALTH_URL` | Recommended | `https://describeops.example.com/health` |

The workflow at `.github/workflows/deploy-alibaba.yml` runs tests, synchronizes the repository without overwriting `.env`, rebuilds the Compose services, applies migrations, and checks the public health endpoint on every push to `main`. It can also be started manually with `workflow_dispatch`.

## 6. View container logs without SSH

The Compose stack includes Dozzle at `https://YOUR_DOMAIN/logs/`. Dozzle is a lightweight live Docker log viewer; it reads Docker logs through the host Docker socket and does not replace long-term log storage.

Before deploying this route, set basic-auth credentials in `/opt/describeops/.env`:

```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'replace-with-strong-password'
```

Then add:

```bash
LOGS_BASIC_AUTH_USER=logs
LOGS_BASIC_AUTH_HASH='$2a$14$replace-with-caddy-bcrypt-hash'
```

Keep Dozzle behind authentication. It mounts `/var/run/docker.sock` read-only, but anyone who can access the log UI can still view application logs and metadata for every container in the stack.

## Operations

View status and logs:

```bash
cd /opt/describeops
docker compose ps
docker compose logs -f --tail=200
```

Restart or rebuild:

```bash
docker compose --env-file .env up -d --build
```

Run a Django command:

```bash
docker compose exec backend python manage.py check --deploy
```

Process one queued job manually, useful when debugging a stuck queue:

```bash
docker compose exec worker python manage.py runworker --once
```

Users can cancel, retry, and delete jobs from the web app. Operators can confirm the queue is draining by watching `job.queued`, `job.started`, `job.succeeded`, `job.failed`, and `job.canceled` events in the session event stream or container logs.

Docker volumes keep media and TLS data across container rebuilds. They do not replace backups: use Neon backups for PostgreSQL and regularly copy the `describeops_media` volume or move media to object storage before scaling to multiple ECS instances.
