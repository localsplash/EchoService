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

- `GET /ping` — settings-independent liveness; `GET /health` — gated database check
- `GET|POST|DELETE /api/conversations/...` — threads, messages, read state
- `GET|POST|DELETE /api/drafts/:customer/media` — draft attachments
- `POST /api/conversations/:customer/send` — outbound SMS/MMS
- `GET|POST|PUT /api/carriers`, `/api/carrier-applications`, `/api/business-phones`
- `POST /api/media/obtain[/:messageId]` — fetch provider-hosted media
- `POST /webhooks/bandwidth/{inbound,status}`, `/webhooks/tychron/{sms,mms}`

## Configuration

`PlatformConfig/cfg_tbl_Setting` is the only runtime settings source. The read-only NocoDB reader resolves
`PlatformConfig/cfg_tbl_Setting` by unique names and combines nonblank values
in scope order `*`, `echo`, `echo-service` (most specific wins). It never reads
legacy SQL settings or IdentityBase. Duplicate scoped keys or
ambiguous/missing bases and tables fail the read; blank rows are unset.

Provide `NOCODB_BASE_URL` and a service-owned `NOCODB_API_TOKEN` directly in
the deployment environment. File bootstrap, shared Identity mounts, and the
first-run settings wizard have been removed. Missing credentials follow the
same retry-once then exit behavior as any unavailable settings source.

The reader caches values and discovered IDs for 30 seconds. Configured startup
retries once after five seconds, then exits if the selected source is unavailable.
A failed runtime refresh clears settings and causes the settings gate to return
503. It never falls back to SQL, IdentityBase, environment-only settings, or an
expired snapshot. `/ping` remains independent of configuration. `/health` checks the application
database behind the network/settings gates.

Runtime keys are `CORS_ORIGINS`, `WEBHOOK_BASIC_USER`, `WEBHOOK_BASIC_PASS`,
`BANDWIDTH_ACCOUNT_ID`, `BANDWIDTH_API_TOKEN`, `BANDWIDTH_API_SECRET`,
`BANDWIDTH_APPLICATION_ID`, and `BANDWIDTH_MESSAGING_API_BASE_URL`. Nonblank
values explicitly pinned in the environment override these rows. The shared
`trustedCIDR` policy belongs in global scope `*`; `IDENTITY_TRUSTED_NETWORK`
remains an explicit deployment override. The API policy is loaded at startup
and on operator reload; its established policy is retained after a failed policy
reload. The runtime settings gate still refuses requests after a failed settings
refresh. This service never writes settings or network policy.

| Deployment variable | Purpose |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Echo application database pool; retained as process bootstrap in this release |
| `PORT` | Listener, default `8080` |
| `MEDIA_ROOT` | Media mount path, default `/media`; match EchoMedia's shared mount |
| `NOCODB_BASE_URL`, `NOCODB_API_TOKEN` | Service-specific settings-store bootstrap |
| `TRUSTED_PROXIES` | Optional deployment proxy trust control |

Database coordinates, ports, media paths and bootstrap credentials require a
restart to change. They are deployment invariants, not hot-reloaded scoped
settings. There is no dotenv loader: export variables for `npm start`; Compose
forwards the variables in its environment block.

## Disposable Dev deployment

The current Dev environment deliberately discards obsolete settings and local
authentication/provenance data. There is no legacy mode, preserved SQL settings
copy or rollback waiting period. Deploy this service and the matching EchoWeb
revision with service-owned NocoDB credentials, then apply EchoDatabase migration
`013_retire_legacy_configuration_and_auth.sql`.

Verify effective `*`, `echo`, `echo-service` values, database connectivity,
webhook authentication, network-policy gates, inbound/outbound SMS/MMS, media,
and settings failure/recovery in the running Dev deployment. Record the exact
versions and results in [EchoOrchestrator #11](https://github.com/localsplash/EchoOrchestrator/issues/11).
Active `sms_*` tables and the migration ledger remain in use.

Asterisk/OfficePulse own PBX extensions, queues, memberships, trunks, and
operational state. This SMS/MMS service does not replicate or provision them.
AidaAgent and AidaHandset are outside this migration.

## Container user

The container retains **uid 100 / gid 101** for existing media and log volume
ownership. It no longer needs to share Identity's bootstrap file or UID.
Upgrading an install that ran as root still requires assigning the existing
media volume to this container user.

## Validation

Use Node 22 (or the Docker image's supported Node runtime), `npm ci`, then
`npm test`. The settings tests use controlled HTTP responses and a SQL spy to
verify scope precedence, pagination, cache expiry, failure recovery, rejection
of the retired source and required service-owned bootstrap. The startup suite launches the actual service against a temporary loopback
settings endpoint, checks webhook authentication, and verifies retry-once then
exit with no MySQL settings server. Tests do not claim live provider or
deployment validation.
