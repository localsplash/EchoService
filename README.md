# EchoService

Mid-tier API for frontend data interactions.

## Run locally

```bash
npm install
npm start
```

## Docker

```bash
docker compose up -d --build
```

## Endpoints

- `GET /health`
- `GET /api/ping`
- `POST /api/echo`

## Configuration

Settings come from `echo_tbl_Settings` in the Echo database — rows where `sApp`
is `'*'` (every Echo app) or `'service'` (this one). The `.env` states only how
to reach that database.

One value is read from outside it: **`trustedCIDR`**, the platform-wide network
policy held in the NocoDB base `IdentityBase`. This service uses it to decide
which callers may reach the webhook endpoints without basic auth. identity owns
and writes that row; this service only ever reads it.

Finding that NocoDB is the one thing that cannot come from a settings table, so
it is resolved in this order:

1. **`NOCODB_BASE_URL` / `NOCODB_API_TOKEN` in the environment.** A deployment
   already stating them keeps doing so.
2. **`/data/config.json`** — two keys, mode 0600, on a volume so it survives a
   rebuild. On a single-host install this is *identity's* file, mounted
   read-only: identity's `/setup` writes it and this service simply finds it.
   That is the zero-config path — set up identity and Echo follows.
3. **The first-run wizard at `/setup`.** For a host with no volume to share.
   It asks for those two values and writes the file, then restarts.

With none of the three, the service starts in **setup mode**: it serves
`/setup` and refuses everything else, rather than exiting. Exiting was a dead
end — on a fresh host there is nothing to edit that would recover it.

The wizard never asks for `trustedCIDR`. A second place to set it is a second
way for two services to disagree about the network policy, which is exactly
what one shared row prevents. `/setup` is reachable from loopback and the
RFC1918 ranges only (`SETUP_ALLOW_FROM` widens it): an unconfigured service
cannot consult `trustedCIDR` to decide who to trust, and whoever answers the
wizard chooses the NocoDB that supplies it.

## Container user

Runs as **uid 100**, matching identity and EchoWeb. That is a platform
invariant, not a coincidence: identity writes `/data/config.json` mode 0600 as
uid 100, and a shared read-only mount only works if the reader is the same uid.
It is pinned with `adduser -u 100` in all three images.

Upgrading an install that ran this service as root needs a one-time
`chown -R 100:101` of the media volume.
