# Gopherfy

[![CI](https://github.com/ravindu-ranasinghe/umn-discord-verification/actions/workflows/ci.yml/badge.svg)](https://github.com/ravindu-ranasinghe/umn-discord-verification/actions/workflows/ci.yml)

A Discord verification bot that confirms a member owns a real `@umn.edu`
email address, remembers them, and auto-assigns the "verified" role in
any server running Gopherfy where that member shows up later.

Built by **Eric He** and **Ravindu Ranasinghe**.

## Secret scanning (GitHub)

Enable **Secret scanning** (and push protection if available) for this
repository: **Settings → Code security and analysis**. See
[About secret scanning](https://docs.github.com/en/code-security/secret-scanning/about-secret-scanning).
CI also runs **gitleaks** on every workflow.

## What it does

When someone joins a Discord server running Gopherfy, they start with no
verified role and only see a verification channel. They click **Start
verification** on the panel, enter their `@umn.edu` email, receive a
6-digit code by email, and submit the code back to the bot. If the code
matches, the bot stores the link between their Discord account and their
UMN email and grants the verified role.

The next time that same Discord user joins a _different_ server running
Gopherfy, the bot recognizes them from the shared database and assigns
the verified role automatically — no second email round-trip.

Mods can run `/whois @user` to see which `@umn.edu` address a member
verified with.

## How users are stored

Gopherfy uses a single SQLite database (`verified.db`) with two tables,
defined in [src/bot/db.js](src/bot/db.js):

```sql
CREATE TABLE verified_users (
  discord_id  TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  verified_at INTEGER
);

CREATE TABLE guild_config (
  guild_id           TEXT PRIMARY KEY,
  verified_role_id   TEXT NOT NULL,
  unverified_role_id TEXT NOT NULL,
  configured_at      INTEGER
);
```

`verified_users` is the cross-server memory. `discord_id` is the
primary key so each Discord account can only ever be linked to one
email, and `email UNIQUE` ensures the reverse — one UMN identity can
only verify one Discord account. Attempts to reuse an email on a second
account are rejected by the bot before an OTP is even sent.

`guild_config` stores per-server settings — which role to grant after
verification — set by an admin running `/setup`.

When a user joins a new server, the bot's `guildMemberAdd` handler
looks up their Discord ID in `verified_users`; if present, it grants
the configured verified role immediately.

SQLite comfortably handles this schema at the scale Gopherfy is aimed
at (thousands of UMN students across many servers) on a single host.

## How emails are sent

Gopherfy is split into two processes:

1. **The bot** (`src/bot/`) — talks to Discord, owns the database, and
   handles slash commands, buttons, and modals.
2. **The OTP service** (`src/otp-service/`) — a small HTTP service that
   generates 6-digit codes, sends them via [Resend](https://resend.com),
   and verifies what the user submits.

The two communicate over HTTP. When a user enters their email, the bot
POSTs to `/send` on the OTP service; when the user submits their code,
the bot POSTs to `/verify`. The OTP service returns only a yes/no plus
the email on success — the bot never sees the code itself.

### The send flow

1. Bot validates the address ends in `@umn.edu` and that the email
   isn't already linked to a different Discord account.
2. Bot calls `POST /send` with the Discord ID and email.
3. OTP service checks the per-user send rate limit (3 per hour).
4. It generates a 6-digit code with `crypto.randomInt`.
5. It hands the code to Resend, which delivers the email.
6. _Only if_ Resend accepts the send does the service store the code
   in memory and consume a rate-limit slot. Failed sends leave no
   trace — a legitimate user is never locked out because of an
   upstream email outage.

### The verify flow

1. Bot calls `POST /verify` with the Discord ID and the submitted code.
2. OTP service looks up the pending code for that Discord ID.
3. It compares in constant time (`crypto.timingSafeEqual`).
4. Each pending OTP allows at most 5 wrong guesses — on the fifth
   wrong code the entry is deleted and the user has to request a new
   one.
5. On success, the service returns the verified email, the bot writes
   `(discord_id, email, now)` into `verified_users`, and the user gets
   the role.

Codes live for 10 minutes and are held in memory (not in SQLite) —
they're ephemeral by design and don't need to survive a restart of the
OTP service.

### Why two processes

Splitting email out of the bot means:

- The bot can be restarted (for code updates, Discord gateway reconnects,
  role changes) without losing in-flight verification attempts — or,
  the reverse, the OTP service can be restarted without dropping the
  bot's connection to Discord.
- The Resend API key is only used by the OTP service (from `.env` in
  development, or Secret Manager in production — never by the Discord bot).
- If Gopherfy ever needs to swap email providers, only one small
  service changes.

The two services authenticate to each other with **HMAC-SHA256**
request signing over the raw JSON body plus a timestamp
(`OTP_SERVICE_KEY`). Without a valid signature, the OTP service refuses
every request — so even if the service port is reachable on the host
network, nobody can request codes to arbitrary addresses or brute-force
someone else's pending code.

## Production deployment (Google Cloud)

In production (`NODE_ENV=production`), the four sensitive values
(`DISCORD_TOKEN`, `OTP_SERVICE_KEY`, `OTP_HMAC_KEY`, `RESEND_API_KEY`)
are read from **Google Cloud Secret Manager** instead of `process.env`.

1. Enable the Secret Manager API on your GCP project.
2. Create secrets whose **names** match those env keys exactly. Store
   one value per secret; runtime reads `…/versions/latest` (see
   **Secret rotation** below).
3. Create a **service account** for the workload (for example the GCE
   VM). Grant it `roles/secretmanager.secretAccessor` on each secret
   (or on the project if you accept broader scope).
4. **Attach** that service account to the GCE instance. Do **not** pass
   the four secrets as VM environment variables or in cloud-init. Use
   env only for non-secret config (`LOG_LEVEL`, `FROM_EMAIL`,
   `OTP_SERVICE_URL`, rate-limit tuning, `GCP_PROJECT_ID`, etc.).
5. Set `GCP_PROJECT_ID` on the VM. The Node client uses [Application
   Default
   Credentials](https://cloud.google.com/docs/authentication/application-default-credentials);
   on GCE this is the attached service account. **Do not** deploy a
   downloaded JSON key file for production.

**Local development:** use `NODE_ENV=development` (or leave unset) and
keep the four values in `.env` as today; Secret Manager is not used.

`npm run deploy:commands` uses `loadSecrets()` for `DISCORD_TOKEN`; you
still need `CLIENT_ID` in the environment.

## Secret rotation

Add a **new version** of a secret in the GCP console and retire the old
version when ready. Gopherfy always reads `versions/latest`, so **restart
the bot and OTP processes** after rotation to pick up new material.

For some workloads Google recommends **pinning** a specific version
(e.g. `versions/5`) instead of `latest`, so an accidentally re-enabled
old version cannot change behavior silently. Gopherfy defaults to
`latest` for simplicity; if you need pins, adjust the resource path in
[src/lib/secrets.js](src/lib/secrets.js) and redeploy.

## Commands

| Command                       | Who           | What                                           |
| ----------------------------- | ------------- | ---------------------------------------------- |
| `/setup verified-role:<role>` | Server admins | One-time per-server config                     |
| `/verify-panel`               | Mods          | Post the button-driven verification panel      |
| `/verify [email]`             | Everyone      | Start verification (slash-command flow)        |
| `/code <digits>`              | Everyone      | Submit the 6-digit code                        |
| `/whois <user>`               | Mods          | Look up which UMN email a member verified with |

Most users go through the panel's **Start verification** / **Submit
code** buttons rather than the slash commands directly.

## Authors

- Eric He
- Ravindu Ranasinghe
