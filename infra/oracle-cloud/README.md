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
   `MDAI_KEK` / `MDAI_JWT_SECRET` (generate locally, never reuse dev
   values).
4. `docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.prod.yml up -d`
5. Run migrations (`services/backend/src/db/migrations`) against the
   `postgres` service.
6. Configure the chosen networking mode (Tunnel/WireGuard/direct).
7. Pair the Android app using the single-use pairing code printed to the
   backend's boot log.

## Backups

Daily `pg_dump` to an Oracle Cloud Object Storage bucket (Always Free
tier: 10GB). Retention and KEK-separation are documented in
`docs/architecture/08-deployment-architecture.md` §8.
