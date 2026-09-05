'use strict';

/**
 * Whether the carriers are calling us, and what they got when they did.
 *
 * This exists because of a specific failure that took far too long to name.
 * Inbound Tychron messages stopped arriving, and from inside the service the
 * evidence was indistinguishable between three quite different causes:
 *
 *   - Tychron is posting and we are rejecting it (a 401 — wrong basic auth).
 *   - Tychron is posting to a path we do not serve (a 404 — wrong URL).
 *   - Tychron is not posting at all (nothing — wrong configuration at their
 *     end, or the number was never provisioned against this endpoint).
 *
 * All three look the same from the database: no new inbound rows. The third
 * turned out to be the answer, and establishing that meant reading nginx's
 * access log on the host. A count and a timestamp per provider, shown on the
 * page, distinguishes them in a glance and keeps distinguishing them.
 *
 * `never` is the most important value this reports. An endpoint that has not
 * been called since the process started is a fact worth stating plainly rather
 * than an absence for someone to notice.
 */

const { clientIp, formatIpv4 } = require('./trust');

/** Recent calls kept for the page; enough to see a pattern, not a log. */
const HISTORY = 50;

const providers = new Map();
const history = [];

function blank(provider) {
  return {
    provider,
    calls: 0,
    accepted: 0, // 2xx — we took the message
    rejected: 0, // 401/403 — reached us, we said no
    failed: 0, // 4xx/5xx otherwise — reached us, something else went wrong
    firstAt: null,
    lastAt: null,
    lastStatus: null,
    lastFrom: null,
    lastPath: null,
  };
}

function bucketFor(provider) {
  if (!providers.has(provider)) providers.set(provider, blank(provider));
  return providers.get(provider);
}

/**
 * Middleware recording the outcome of a carrier webhook.
 *
 * Mounted *outside* the auth check so a rejected call is still counted — a
 * silent endpoint and one refusing every call are the two cases this is here
 * to tell apart, and only one of them ever reaches the handler.
 */
function watch(provider, trustedProxies) {
  bucketFor(provider); // so the page can say "never" rather than omit it
  return function record(req, res, next) {
    const startedAt = new Date();
    res.on('finish', () => {
      const bucket = bucketFor(provider);
      const from = formatIpv4(clientIp(req, trustedProxies).ip);
      bucket.calls += 1;
      if (res.statusCode < 300) bucket.accepted += 1;
      else if (res.statusCode === 401 || res.statusCode === 403) bucket.rejected += 1;
      else bucket.failed += 1;
      bucket.firstAt = bucket.firstAt || startedAt.toISOString();
      bucket.lastAt = startedAt.toISOString();
      bucket.lastStatus = res.statusCode;
      bucket.lastFrom = from;
      bucket.lastPath = req.originalUrl || req.url;

      history.push({
        provider,
        at: startedAt.toISOString(),
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        from,
      });
      if (history.length > HISTORY) history.splice(0, history.length - HISTORY);
    });
    next();
  };
}

function snapshot() {
  return {
    providers: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    recent: [...history].reverse(),
  };
}

module.exports = { watch, snapshot };
