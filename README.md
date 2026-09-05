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

- `GET /ping`, `GET /health` — liveness; both answer in setup mode
- `GET|POST|DELETE /api/conversations/...` — threads, messages, read state
- `GET|POST|DELETE /api/drafts/:customer/media` — draft attachments
- `POST /api/conversations/:customer/send` — outbound SMS/MMS
- `GET|POST|PUT /api/carriers`, `/api/carrier-applications`, `/api/business-phones`
- `POST /api/media/obtain[/:messageId]` — fetch provider-hosted media
- `POST /webhooks/bandwidth/{inbound,status}`, `/webhooks/tychron/{sms,mms}`
- `GET /setup`, `GET /api/setup/status`, `POST /api/setup/bootstrap` — first run

## Required environment

| Variable | Why it is here |
| --- | --- |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Where `echo_tbl_Settings` lives — a database cannot carry its own address |

`PORT` (8080) and `MEDIA_ROOT` (`/media`) have defaults; `NOCODB_BASE_URL` /
`NOCODB_API_TOKEN`, `IDENTITY_TRUSTED_NETWORK`, `SETUP_ALLOW_FROM` and
`ECHO_CONFIG_DIR` are optional and described in `.env.example`. There is no
dotenv here: `npm start` reads the process environment, and `.env` is what
Docker Compose substitutes into `docker-compose.yml`.

## Configuration

Settings come from `echo_tbl_Settings` in the Echo database — rows where `sApp`
is `'*'` (every Echo app) or `'service'` (this one). The `.env` states only how
to reach that database.

Any of those keys may also be pinned in the environment, where it **overrides**
the row (blank counts as unset) — see `.env.example` for the list. A stale
override wins over a correct row, so pin only what you mean to override.

`MEDIA_ROOT` is not one of them. It is a mount point, read once at startup, and
every stored path on disk is relative to it — so it is an environment variable
and the volume mount decides it, not a settings row.

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
