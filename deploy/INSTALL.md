# Gopherfy production install (GCE + systemd)

Manual steps for a first-time deploy on a Google Compute Engine VM running
Debian/Ubuntu-style Linux with Node.js 20+ (`/usr/bin/node`). Secrets are
loaded from **Secret Manager** when `NODE_ENV=production` (see README).

## 1. System user and directories

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gopherfy
sudo mkdir -p /opt/gopherfy/data
sudo chown -R gopherfy:gopherfy /opt/gopherfy
```

`verified.db` (and WAL/SHM) live under `/opt/gopherfy/data` via `GOPHERFY_DATA_DIR`.

## 2. Application code

Clone or rsync the repository to `/opt/gopherfy` as `gopherfy`:

```bash
sudo -u gopherfy git clone https://github.com/YOUR_ORG/Gopherfy.git /opt/gopherfy
# or: rsync -a ./Gopherfy/ gopherfy@vm:/opt/gopherfy/
```

Install production dependencies only:

```bash
cd /opt/gopherfy
sudo -u gopherfy npm ci --omit=dev
```

## 3. Non-secret environment

Edit the `Environment=` lines in each unit file **before** copying, or use an
`EnvironmentFile=` pointing at a root-only file. Set at minimum:

- `GCP_PROJECT_ID` — project that holds Secret Manager secrets and (for backups) GCS.
- `FROM_EMAIL` — Resend-sender address (OTP unit).
- `BACKUP_GCS_BUCKET` / `BACKUP_GPG_RECIPIENT` — backup unit only.

Do **not** put `DISCORD_TOKEN`, `OTP_SERVICE_KEY`, `OTP_HMAC_KEY`, or
`RESEND_API_KEY` in environment files on disk; they come from Secret Manager.

## 4. systemd units

```bash
sudo cp deploy/systemd/gopherfy-bot.service /etc/systemd/system/
sudo cp deploy/systemd/gopherfy-otp.service /etc/systemd/system/
sudo cp deploy/systemd/gopherfy-backup.service /etc/systemd/system/
sudo cp deploy/systemd/gopherfy-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gopherfy-bot gopherfy-otp gopherfy-backup.timer
```

## 5. Logs

Live follow:

```bash
journalctl -u gopherfy-bot -f
journalctl -u gopherfy-otp -f
journalctl -u gopherfy-backup.service -f
```

## 6. Security posture

```bash
systemd-analyze security gopherfy-bot.service
```

Target **≤ 4.0** (“exposure: low”). Verify process user:

```bash
ps -o user= -p $(pgrep -f 'node /opt/gopherfy/src/bot/index.js')
```

Expect `gopherfy`, not `root`. A deliberate `kill` of the bot process should
restart it within about five seconds (`Restart=on-failure`).

## 7. GCS backup bucket

Create a bucket, e.g. `gopherfy-backups-PROJECT_ID`:

- **Lifecycle:** delete objects older than 30 days (GDPR-friendly retention).
- **Versioning:** enabled.
- **IAM:** grant the VM service account `roles/storage.objectAdmin` on this
  bucket only (not the whole project if avoidable).

Ensure the backup host has the **GPG public key** for `BACKUP_GPG_RECIPIENT`
in its keyring; restores need the **private key** on an operator machine.

## 8. Monthly restore drill

Calendar reminder: at least monthly, run `npm run restore latest` (or
`node scripts/restore.js latest`) on a non-production host with GCS + GPG
access, confirm `integrity_check` is `ok`, and document the result. Replacing
production `verified.db` stays a **manual** step after verification.

## 9. Firewall

See [firewall.md](firewall.md) for GCP VPC expectations.
