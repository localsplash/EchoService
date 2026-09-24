# EchoService

Mid-tier API for frontend data interactions.

## Run locally

```bash
npm install
npm start
```

## Docker

A throwaway local instance, with its own volumes and a loopback port:

```bash
docker compose -f compose.dev.yaml up -d --build
```

An environment deploys the service from `compose.yaml`, which defines only this
service and takes every name from the environment (see `.env.example`):

```yaml
include:
  - EchoService/compose.yaml
```

### Deployment networks

| Network | Who is on it | Why |
| --- | --- | --- |
| `ECHO_NETWORK` | EchoWeb, MySQL, NocoDB, EchoMedia | Where EchoWeb calls this service. Normally an internal network, so the service has no internet route by default. |
| `ECHO_PROXY_NETWORK` | the reverse proxy | Added by `compose.proxy.yaml`, for carrier webhook ingress. It also gives the service its internet route, which is what lets it deliver to Bandwidth and Tychron. |

Enable the overlay in the environment's `.env`; leave the line out where no
carrier delivers to that environment:

```
COMPOSE_FILE=compose.yaml:compose.proxy.yaml
```

### Carrier webhook ingress

Bandwidth and Tychron call from their own networks, so the four webhook routes
have to be reachable from the internet. They are the only routes that are, apart
from `/ping` and `/healthz`:

- `POST /v1/bandwidth/{inbound,status}`
- `POST /v1/tychron/{sms,mms}`

They authenticate themselves with basic auth from `WEBHOOK_BASIC_USER` and
`WEBHOOK_BASIC_PASS` in PlatformConfig, and `webhookWatch` records every call so
a silent carrier stays visible. Everything else is refused unless the caller is
inside the `trustedCIDR` row, which a request arriving through the proxy is not,
so the API cannot be reached from the public side.

The environment's proxy host needs to:

- publish one hostname for this service (for example `echo-webhook.X.TLD`) and
  forward it to port `8080` — no host port is published;
- allow request bodies up to `10m`, since MMS payloads arrive inline;
- leave `TRUSTED_PROXIES` at its loopback default, so `X-Forwarded-For` from the
  proxy is ignored and no public request can be mistaken for a trusted one.

Use [`deploy/nginx/echo-webhook.X.TLD.conf`](deploy/nginx/echo-webhook.X.TLD.conf)
as the proxy-host template, substituting the parent domain and certificate paths.
The hostname follows `<app>-<role>.X.TLD`, matching names such as
`aida-admin.X.TLD`. Keeping it one label below the parent domain allows a
`*.X.TLD` certificate to cover it; the proxy still needs a matching host entry.
EchoWeb calls `http://echo-service-private:8080`, a DNS name registered only
on the private network by `compose.yaml`. This keeps internal API requests
inside `trustedCIDR` even when both services also join the proxy network.
The proxy uses the ordinary `echo-service` name on its own network.

It forwards only `/v1/` and `/ping` to `echo-service:8080`; other paths
return 404 at the edge. Register the four URLs with their respective carriers.

### Carrier cutover URLs

Replace `X.TLD` with this environment's `PARENT_DOMAIN`. Give the carriers these
complete HTTPS URLs, all using `POST`:

| Carrier configuration | Webhook URL | Events received |
| --- | --- | --- |
| Bandwidth incoming-message callback | `https://echo-webhook.X.TLD/v1/bandwidth/inbound` | Incoming SMS/MMS |
| Bandwidth outgoing-message callback | `https://echo-webhook.X.TLD/v1/bandwidth/status` | Outbound message status/delivery events |
| Tychron Switch SMS callback | `https://echo-webhook.X.TLD/v1/tychron/sms` | Incoming SMS and SMS delivery reports |
| Tychron Switch MMS callback | `https://echo-webhook.X.TLD/v1/tychron/mms` | Incoming MMS and MMS delivery reports |

Configure HTTP Basic authentication on every callback using the effective
`WEBHOOK_BASIC_USER` and secret `WEBHOOK_BASIC_PASS` settings (`*` < `echo` <
`echo-service`). Set them in the carrier's authentication fields; do not embed
credentials in the URLs. Configure Tychron's Switch for each tenant's numbers.

Before registering the URLs, provision the hostname and its TLS certificate,
forward `/v1/` and `/ping` to `echo-service:8080`, and verify HTTPS
`GET /ping` returns 200. An unauthenticated POST from outside `trustedCIDR` to
each callback should return 401. Then register the callbacks and verify real
inbound messages and outbound delivery reports with the carrier credentials.
The old `/webhooks/*` paths have no forwarding aliases.

These are callbacks **into Echo**, distinct from Tychron's outbound SMS/MMS
send endpoints documented below.

### Tychron settings

`TYCHRON_SMS_URL` and `TYCHRON_MMS_URL` belong in PlatformConfig, resolved in
scope order `*` < `echo` < `echo-service`. Defaults follow Tychron's messaging
OpenAPI specifications: `https://sms.tychron.online/sms` and
`https://mms.tychron.online/api/v1/mms`. The Atlas base
`https://api.atlas.tychron.online/api/v1/` is the provisioning API; its live
OpenAPI contract has no SMS/MMS send routes. Do not append messaging paths to it.
See the [SMS specification](https://docs.tychron.com/openapi/sms.openapi.yaml),
[MMS specification](https://docs.tychron.com/openapi/mms.openapi.yaml), and
[Atlas scope](https://docs.tychron.com/llms-full.txt).

Each carrier application's `jsonSettings` needs only its own `apiToken`.
Optional `smsUrl`/`mmsUrl` application overrides take precedence for staging.
The private carrier-applications response includes the effective platform
endpoints so EchoWeb can display them without maintaining a second default.

For every tenant number, configure its Tychron Switch to deliver SMS/MMS and
status reports to `https://echo-webhook.X.TLD/v1/tychron/{sms,mms}` with
`WEBHOOK_BASIC_USER` and `WEBHOOK_BASIC_PASS` from PlatformConfig. Bandwidth uses
`/v1/bandwidth/{inbound,status}` on the same hostname. `/v1` is carrier ingress
only; the private `/api` remains unversioned. The former `/webhooks/*` routes
are removed with no aliases: update registrations when deploying this change.

## Endpoints

- `GET /ping` — settings-independent liveness; `GET /health` — gated database check
- `GET|POST|DELETE /api/conversations/...` — threads, messages, read state
- `GET|POST|DELETE /api/drafts/:customer/media` — draft attachments
- `POST /api/conversations/:customer/send` — outbound SMS/MMS
- `GET|POST|PUT /api/carriers`, `/api/carrier-applications`, `/api/business-phones`
- `POST /api/media/obtain[/:messageId]` — fetch provider-hosted media
- `POST /v1/bandwidth/{inbound,status}`, `/v1/tychron/{sms,mms}`

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

Browser origins must match an entry in the comma-separated `CORS_ORIGINS` row
or `https://echo.<PARENT_DOMAIN>` exactly. There are no implicit production,
`.local`, `.test`, `.internal`, or localhost allowances. Add development origins
explicitly in PlatformConfig. Requests without an Origin header still pass CORS;
the network and authentication gates apply independently. Before deployment,
verify the environment's `PARENT_DOMAIN` or `CORS_ORIGINS` row is populated.

Runtime keys are `PARENT_DOMAIN`, `CORS_ORIGINS`, `WEBHOOK_BASIC_USER`, `WEBHOOK_BASIC_PASS`,
`BANDWIDTH_ACCOUNT_ID`, `BANDWIDTH_API_TOKEN`, `BANDWIDTH_API_SECRET`,
`BANDWIDTH_APPLICATION_ID`, and `BANDWIDTH_MESSAGING_API_BASE_URL`. These come
only from PlatformConfig; a same-named environment variable is ignored, so a
rotated row always takes effect. The shared
`trustedCIDR` policy belongs in global scope `*`; `IDENTITY_TRUSTED_NETWORK`
is retired and ignored. The API policy is loaded at startup
and on operator reload; its established policy is retained after a failed policy
reload. The runtime settings gate still refuses requests after a failed settings
refresh. This service never writes settings or network policy.

| Deployment variable | Purpose |
| --- | --- |
| `PORT` | Listener, default `8080` |
| `MEDIA_ROOT` | Media mount path, default `/media`; match EchoMedia's shared mount |
| `NOCODB_BASE_URL`, `NOCODB_API_TOKEN` | Service-specific settings-store bootstrap |
| `TRUSTED_PROXIES` | Optional deployment proxy trust control |

`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and secret `DB_PASSWORD` are
PlatformConfig settings (`*` < `echo` < `echo-service`); environment pins are
ignored. Without a `DB_HOST` row, the host derives as `lsdb.<PARENT_DOMAIN>`.
The port defaults to 3306. Set DB_NAME and this service's own DB_USER explicitly.
The MySQL pool opens on first use; missing coordinates give an actionable error
while liveness stays available. Once a pool exists, coordinate edits require a
restart. Store application credentials only; MySQL admin credentials stay with
the operator's EchoDatabase migration/account jobs. Their application passwords
must match the corresponding PlatformConfig rows.

Ports, media paths and settings-store credentials also require restart. There is no dotenv loader: export variables for `npm start`; Compose
forwards the variables in its environment block.

## Disposable Dev deployment

The current Dev environment deliberately discards obsolete settings and local
authentication/provenance data. There is no legacy mode, preserved SQL settings
copy or rollback waiting period. Deploy this service and the matching EchoWeb
revision with service-owned NocoDB credentials, then apply EchoDatabase migration
`013_retire_legacy_configuration_and_auth.sql`.

Verify effective `*`, `echo`, `echo-service` values, database connectivity,
webhook authentication, network-policy gates, inbound/outbound SMS/MMS, media,
and settings failure/recovery in the running Dev deployment.
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

## Health version and Pacific timezone

The liveness response includes `version` (`YYYY.M.D.H.M`), full Git `revision`,
`sourceUpdatedAt` (ISO 8601 with Pacific offset), `timeZone` (`America/Los_Angeles`),
and `dirty`. Existing status fields and readiness behavior are preserved.
EchoService exposes `/healthz` as an alias of settings-independent `/ping`; the gated
`/health` database check also includes the identity.

Versions use HEAD's committer timestamp in Pacific time (PST/PDT), never build time.
For example, `2026-09-14T21:30:42Z` becomes `2026.9.14.14.30` and
`sourceUpdatedAt: "2026-09-14T14:30:42-07:00"`. The clock belongs to the machine
creating the commit, including GitHub for web-created commits. Rebuilding a commit
preserves its version. Same-minute commits and the repeated autumn DST hour are
distinguished by `revision`; dates alone are not a monotonic sequence.

`npm run build` embeds identity in the artifact. Uncommitted/staged/untracked changes
append `-dirty`; commit before building releases. Unbuilt source development reports
`unbuilt` with null revision fields. Package and API contract versions stay separate.
Runtime `TZ` defaults to `America/Los_Angeles` and may be overridden explicitly;
version formatting always stays Pacific. Docker includes timezone data. Explicit UTC
storage/protocol timestamp contracts remain UTC to preserve existing data semantics.

Docker/source archive builds require all three values: `BUILD_REVISION` (full SHA),
`SOURCE_DATE_EPOCH` (Git committer epoch), and `BUILD_DIRTY` (`true` or `false`).
Missing or malformed identity fails the build. The wrapper derives them from Git:

```sh
scripts/with-build-info.sh sh -c 'docker build \
  --build-arg BUILD_REVISION --build-arg SOURCE_DATE_EPOCH --build-arg BUILD_DIRTY \
  -t echoservice:local .'
scripts/with-build-info.sh docker compose up -d --build

```

External orchestrators building this Dockerfile must forward these same build args.
No runtime Git checkout or version environment override is needed.
