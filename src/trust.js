'use strict';

/**
 * Is the caller inside the platform's own network?
 *
 * `trustedCIDR` is one value for the whole platform — a row in
 * PlatformConfig.cfg_tbl_Setting that identity and every application read,
 * rather than a differently-named CIDR per service. It is the one setting
 * this service reads from outside the Echo database, because a network
 * policy only works if everyone agrees on it. It describes a network: every
 * first-party server inside it is trusted, and nothing outside it is.
 *
 * A header any client can write is not evidence of where a request came from,
 * so `X-Forwarded-For` is consulted only when the socket peer is a proxy this
 * service has been told to trust — see `clientIp` for the rule and why the
 * rightmost entry is the only honest one. IPv6 peers are never trusted; a
 * dual-stack `::ffff:a.b.c.d` peer is the kernel reporting an IPv4 connection
 * and is normalised.
 */

function ipv4ToNumber(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** "10.9.0.0/16", "203.0.113.7/32" or a bare "203.0.113.7" (treated as /32). */
function parseCidr(entry) {
  const [addr, bitsRaw] = entry.trim().split('/');
  const base = ipv4ToNumber(addr || '');
  if (base === null) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  // >>> 0 keeps the mask unsigned; a /0 shift of 32 is undefined in JS.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network: (base & mask) >>> 0, mask };
}

function parseCidrList(raw) {
  return String(raw || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseCidr)
    .filter(Boolean);
}

/** The socket peer as an IPv4 number, or null when there isn't one. */
function peerIpv4(req) {
  const raw = (req.socket && req.socket.remoteAddress) || '';
  const normalised = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return ipv4ToNumber(normalised);
}

function inCidrList(value, cidrs) {
  return value !== null && cidrs.some(({ network, mask }) => ((value & mask) >>> 0) === network);
}

function peerInTrustedNetwork(req, trustedCidr) {
  const cidrs = parseCidrList(trustedCidr);
  if (!cidrs.length) return false; // unset trusts nobody, never everybody
  return inCidrList(peerIpv4(req), cidrs);
}

/**
 * Where a reverse proxy may legitimately sit.
 *
 * A proxy in front of this service is a sibling container or something else on
 * the deployment's own private network; the socket peer of a hop from the
 * public internet is never one. So the default is the private ranges, which is
 * a statement about topology rather than about trust — `TRUSTED_PROXIES`
 * narrows it to the exact proxy address when an operator wants to be strict.
 */
const DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';

/**
 * The address this request actually came from.
 *
 * When the socket peer is not a trusted proxy, that peer *is* the client and
 * any `X-Forwarded-For` it sent is just something it typed. When the peer is a
 * trusted proxy, the header matters — but only its **rightmost** entry.
 *
 * Nginx Proxy Manager forwards `X-Forwarded-For $proxy_add_x_forwarded_for`,
 * which *appends* the address it observed to whatever the client supplied. A
 * client sending `X-Forwarded-For: 10.9.9.9` therefore produces
 * `10.9.9.9, 203.0.113.7` — the left entries are the client's claim and the
 * last is nginx's own observation. Reading the leftmost entry, which is the
 * usual convention and what `trust proxy` does with a hop count of zero, would
 * let any caller name its own source address and walk straight through the
 * network policy. The rightmost cannot be forged without being the proxy.
 *
 * Returns `{ ip, viaProxy }`; `ip` is null when there is no usable IPv4
 * address, which is a caller to refuse rather than to guess about.
 */
function clientIp(req, trustedProxies = DEFAULT_TRUSTED_PROXIES) {
  const peer = peerIpv4(req);
  const proxies = parseCidrList(trustedProxies);
  if (peer === null || !inCidrList(peer, proxies)) return { ip: peer, viaProxy: false };

  const header = (req.headers && req.headers['x-forwarded-for']) || '';
  const hops = String(header)
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i].startsWith('::ffff:') ? hops[i].slice(7) : hops[i];
    const value = ipv4ToNumber(hop);
    if (value !== null) return { ip: value, viaProxy: true };
  }
  // A trusted proxy that forwarded nothing is a first-party caller in its own
  // right — another container on the network, not a hop carrying someone else.
  return { ip: peer, viaProxy: false };
}

function clientInTrustedNetwork(req, trustedCidr, trustedProxies) {
  const cidrs = parseCidrList(trustedCidr);
  if (!cidrs.length) return false; // unset trusts nobody, never everybody
  return inCidrList(clientIp(req, trustedProxies).ip, cidrs);
}

/** Dotted-quad for logs and error screens. Never used for a decision. */
function formatIpv4(value) {
  if (value === null || value === undefined) return 'unknown';
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

module.exports = {
  peerInTrustedNetwork,
  clientIp,
  clientInTrustedNetwork,
  formatIpv4,
  parseCidrList,
  ipv4ToNumber,
  DEFAULT_TRUSTED_PROXIES,
};
