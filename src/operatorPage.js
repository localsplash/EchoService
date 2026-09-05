'use strict';

/**
 * Sending one of this service's self-contained operator pages.
 *
 * The pages here — the setup wizard, the network-policy screens, the log
 * viewer — are each a single string with their script and style inline,
 * because this repo has no build step and a page that needs one stops working
 * exactly when the build is what broke.
 *
 * Helmet's default policy is `script-src 'self'`, which blocks precisely that.
 * The wizard's script has therefore never run in a browser: the page rendered,
 * the form did nothing, and the console error was somewhere nobody was
 * looking. Rather than weaken the policy for the whole service with
 * `'unsafe-inline'`, each page gets a fresh nonce and a policy that permits
 * that one block and nothing else — no external script, no frame, no form
 * post, no object.
 */

const crypto = require('crypto');

/**
 * `html` must contain a literal `<script>` and may contain a literal
 * `<style>`; both are given the nonce.
 */
function sendOperatorPage(res, html, status = 200) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  return res
    .status(status)
    .set('Content-Security-Policy', policy)
    .set('Content-Type', 'text/html; charset=utf-8')
    .send(
      html
        .replace('<script>', `<script nonce="${nonce}">`)
        .replace('<style>', `<style nonce="${nonce}">`)
    );
}

module.exports = { sendOperatorPage };
