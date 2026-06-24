# Deploy DescribeOps to Alibaba Cloud ECS

This is the single production deployment path for DescribeOps. One Alibaba Cloud ECS instance runs the web app, HTTPS edge, and Django API with Docker Compose. Neon provides managed PostgreSQL, so no database container or Alibaba RDS instance is required.

The stack contains:

- `web`: the Vite React build served by Caddy. Caddy also obtains and renews HTTPS certificates.
- `backend`: Django, Gunicorn, FFmpeg, and yt-dlp.
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
- Matching values for `DESCRIBEOPS_API_TOKEN` and `VITE_API_TOKEN`.

`VITE_API_TOKEN` is compiled into browser JavaScript, so it must not be treated as a confidential credential. It is only a shared application gate.

## 4. Start manually

The whole application starts with:

```bash
cd /opt/describeops
docker compose --env-file .env up -d --build
docker compose ps
```

The backend container automatically runs migrations and `collectstatic` before starting Gunicorn. Verify the public endpoint:

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

Docker volumes keep media and TLS data across container rebuilds. They do not replace backups: use Neon backups for PostgreSQL and regularly copy the `describeops_media` volume or move media to object storage before scaling to multiple ECS instances.
