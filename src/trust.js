'use strict';

/**
 * Is the caller inside the platform's own network?
 *
 * `trustedCIDR` is one value for the whole platform — a row in
 * IdentityBase.auth_tbl_Settings that every application reads, rather than a
 * differently-named CIDR per service (see localsplash/identify#15). It
 * describes a network: every first-party server inside it is trusted, and
 * nothing outside it is.
 *
 * Only the TCP socket peer counts. X-Forwarded-For is not consulted here: a
 * header any client can write is not evidence of where a request came from,
 * and this service sits behind no proxy it has been told to trust. IPv6 peers
 * are never trusted — a dual-stack `::ffff:a.b.c.d` peer is the kernel
 * reporting an IPv4 connection and is normalised.
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

function peerInTrustedNetwork(req, trustedCidr) {
  const cidrs = parseCidrList(trustedCidr);
  if (!cidrs.length) return false; // unset trusts nobody, never everybody
  const peer = peerIpv4(req);
  if (peer === null) return false;
  return cidrs.some(({ network, mask }) => ((peer & mask) >>> 0) === network);
}

module.exports = { peerInTrustedNetwork, parseCidrList, ipv4ToNumber };
