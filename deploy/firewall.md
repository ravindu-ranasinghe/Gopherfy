# Gopherfy firewall notes (GCP)

## OTP service bind address

The OTP HTTP service listens on **127.0.0.1** only (not `0.0.0.0`). Even
without extra firewall rules it is not reachable from other hosts.

## Default VPC rules

The default GCP VPC firewall **does not** expose arbitrary ports (such as 3001) to the public internet. Confirm effective rules:

```bash
gcloud compute firewall-rules list --format='table(name,direction,allowed)'
```

## Inbound

Typically allow **SSH (tcp:22)** for administration from trusted IPs/CIDRs.
Do not add a rule that opens the OTP port to `0.0.0.0/0`.

## Outbound

The bot and OTP processes need **HTTPS (443)** to reach:

- Discord API / gateway
- Resend API
- Google Cloud APIs (Secret Manager, Cloud Storage for backups)

No inbound listener is required for Discord (outbound-only from the bot).
