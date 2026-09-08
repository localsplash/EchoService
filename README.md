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
- `GET /setup`, `GET /api/setup/status`, `POST /api/setup/bootstrap` — first run

## Configuration

`SETTINGS_MODE=platform` is the default. The read-only NocoDB reader resolves
`PlatformConfig/cfg_tbl_Setting` by unique names and combines nonblank values
in scope order `*`, `echo`, `echo-service` (most specific wins). It never reads
`echo_tbl_Settings` or `IdentityBase` in this mode. Duplicate scoped keys or
ambiguous/missing bases and tables fail the read; blank rows are unset.

Provide `NOCODB_BASE_URL` and a service-owned `NOCODB_API_TOKEN`. An optional
`/data/config.json` (or `ECHO_CONFIG_DIR/config.json`) can supply missing bootstrap
keys. Complete environment credentials skip the file; no Identity configuration
volume is required. Without bootstrap credentials, the restricted `/setup`
wizard remains available. It verifies the selected store with the runtime reader,
saves only the two bootstrap keys, and restarts.

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
| `SETTINGS_MODE` | `platform` by default; `legacy` only for coordinated rollback |
| `ECHO_CONFIG_DIR`, `SETUP_ALLOW_FROM`, `TRUSTED_PROXIES` | Optional local bootstrap/proxy controls |

Database coordinates, ports, media paths and bootstrap credentials require a
restart to change. They are deployment invariants, not hot-reloaded scoped
settings. There is no dotenv loader: export variables for `npm start`; Compose
forwards the variables in its environment block.

## Rollout and retirement

`SETTINGS_MODE=legacy` explicitly restores the original SQL settings reader
(`sApp=*` then `service`) and `IdentityBase/auth_tbl_Settings` network policy.
It is an operator-selected compatibility mode, never an automatic fallback.

Before deployment, seed and verify the effective `*`, `echo`, `echo-service`
values, service token access, and the unchanged Echo database coordinates.
Deploy the matching EchoOrchestrator wiring, then exercise actual inbound and
outbound SMS/MMS, media delivery, webhook authentication, network-policy gates,
and settings-store failure/recovery. A dev merge is not evidence of that check.
Record deployment versions, results, rollback owner and rollback end date in
[EchoOrchestrator #11](https://github.com/localsplash/EchoOrchestrator/issues/11).

Keep `echo_tbl_Settings`, the legacy source data, and the rollback deployment
until every remaining consumer is migrated and verified and the agreed rollback
window has ended. Removing compatibility readers and dropping the table are
following releases coordinated by
[EchoDatabase #8](https://github.com/localsplash/EchoDatabase/issues/8).
`echo_tbl_SchemaMigration` remains the schema ledger.

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
verify scope precedence, pagination, cache expiry, failure recovery, explicit
legacy compatibility, setup verification and service-owned bootstrap. The startup suite launches the actual service against a temporary loopback
settings endpoint, checks webhook authentication, and verifies retry-once then
exit with no MySQL settings server. Tests do not claim live provider or
deployment validation.
