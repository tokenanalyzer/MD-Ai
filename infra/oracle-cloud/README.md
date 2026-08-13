# Oracle Cloud (Always Free, ARM64)

Provisioning notes for the target compute instance. See
`docs/architecture/08-deployment-architecture.md` for the full resource
budget and networking decision (Cloudflare Tunnel vs. WireGuard vs. direct
exposure).

## Instance

- Shape: **VM.Standard.A1.Flex** (Ampere Altra, ARM64)
- Initial allocation: **2 OCPU / 12GB RAM** (Always Free allows up to 4
  OCPU / 24GB total across A1 instances — the remaining 2/12 is reserved
  headroom, see the architecture doc's resource budget table)
- OS: Ubuntu 22.04 LTS (ARM64) or Oracle Linux 9 (ARM64)
- Boot volume: 50GB (Always Free block storage allowance is 200GB total,
  shared with any backup volumes)

## Bring-up checklist (Phase 7)

1. Provision the instance, attach a reserved public IP only if using direct
   exposure mode (skip if using Cloudflare Tunnel).
2. Install Docker Engine + Compose plugin (arm64 packages).
3. Clone this repo, copy `.env.example` → `services/backend/.env`, fill in
   `MDAI_JWT_SECRET` (generate locally, never reuse dev values). No
   provider key belongs in this file — see
   `docs/architecture/07-security-model.md` §3.
4. `docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.prod.yml up -d`
   — this also starts `caddy` (see `infra/docker/Caddyfile`) and applies
   the resource limits from `docker-compose.prod.yml`. Migrations run
   automatically on backend boot (`src/index.ts` calls `runMigrations`) —
   no separate migration step needed.
5. Configure the chosen networking mode:
   - **Cloudflare Tunnel (default)**: install `cloudflared` on the
     instance (outside this compose file — it needs your own tunnel
     token) pointing at `http://localhost:80` (Caddy). The shipped
     `Caddyfile` already assumes this mode (plain `:80`, no ACME).
   - **Direct exposure**: edit `infra/docker/Caddyfile` to your real
     domain + `tls` directive per the comments in that file, and change
     `caddy`'s port binding in `docker-compose.yml` to expose `:443`
     publicly.
   - **WireGuard**: skip `caddy` entirely — the phone reaches `backend`
     directly over the VPN interface.
6. Pair the Android app using the single-use pairing code printed to the
   backend's boot log.

## Backups

Daily `pg_dump` to an Oracle Cloud Object Storage bucket (Always Free
tier: 10GB). Retention is documented in
`docs/architecture/08-deployment-architecture.md` §8. No provider secrets
are in scope for these backups — the backend doesn't hold any.
