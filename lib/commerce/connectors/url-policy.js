'use strict';
/**
 * T3.1 URL / SSRF boundary for connector requests.
 *
 * The URL is never trusted: credentials, non-http(s) protocols, private/local hosts (listed or
 * not), non-default ports, hosts outside the registration and paths outside the registered
 * scope are rejected before any transport call. Redirects must stay on the registered host.
 * Nothing here performs network I/O.
 */
const { connectorError, pathWithinAllowed } = require('./source-register.js');

const PRIVATE_HOST_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|\[?::1\]?|0\.0\.0\.0|.*\.local|.*\.internal)$/i;

function parseUrlBasics(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw connectorError('url_invalid', 'source URL is not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw connectorError('url_protocol_not_allowed', `source URL protocol ${url.protocol} is not allowed`);
  }
  if (url.username !== '' || url.password !== '') {
    throw connectorError('url_credentials_not_allowed', 'source URL must not carry credentials');
  }
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host)) {
    throw connectorError('url_host_denied_private', 'private/local hosts are never allowed for connector requests');
  }
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port !== '' && url.port !== defaultPort) {
    throw connectorError('url_port_not_allowed', 'non-default ports are not allowed for connector requests');
  }
  return { url, host, path: url.pathname, protocol: url.protocol };
}

function parseAndCheckUrl(rawUrl, source) {
  const basics = parseUrlBasics(rawUrl);
  if (basics.host !== source.host) {
    throw connectorError('url_host_not_allowed', `host ${basics.host} is not the registered source host ${source.host}`);
  }
  if (!pathWithinAllowed(basics.path, source.allowedPaths)) {
    throw connectorError('url_path_not_allowed', `path ${basics.path} is outside the registered source scope`);
  }
  return basics;
}

/** A redirect may only stay on the same registered host and protocol family. */
function assertRedirectAllowed(fromUrl, toUrl, source) {
  const from = parseUrlBasics(fromUrl);
  const to = parseUrlBasics(toUrl);
  if (to.host !== from.host) throw connectorError('redirect_cross_host', 'cross-host redirects are refused');
  if (to.protocol !== from.protocol) throw connectorError('redirect_protocol_not_allowed', 'protocol-changing redirects are refused');
  if (from.host !== source.host) throw connectorError('url_host_not_allowed', `host ${from.host} is not the registered source host ${source.host}`);
  if (!pathWithinAllowed(from.path, source.allowedPaths) || !pathWithinAllowed(to.path, source.allowedPaths)) {
    throw connectorError('url_path_not_allowed', 'redirect target is outside the registered source scope');
  }
  return { from: from.url, to: to.url };
}

/**
 * The canonical request.url is the execution target: it is parsed (protocol/credentials/
 * private-local/port/host/path) and must agree with request.host/request.path and with
 * request.meta.asin. Caller-supplied string metadata can never contradict the real URL.
 */
function assertRequestTarget(request, source) {
  if (!request || typeof request !== 'object' || typeof request.url !== 'string' || request.url === '') {
    throw connectorError('url_missing', 'request.url is required; the canonical URL is the execution target');
  }
  const basics = parseUrlBasics(request.url);
  if (typeof request.host !== 'string' || basics.host !== request.host.toLowerCase()) {
    throw connectorError('request_target_mismatch', 'request.host does not match the canonical request.url host');
  }
  if (typeof request.path !== 'string' || basics.path !== request.path) {
    throw connectorError('request_target_mismatch', 'request.path does not match the canonical request.url path');
  }
  if (basics.host !== source.host) {
    throw connectorError('url_host_not_allowed', `host ${basics.host} is not the registered source host ${source.host}`);
  }
  if (!pathWithinAllowed(basics.path, source.allowedPaths)) {
    throw connectorError('url_path_not_allowed', `path ${basics.path} is outside the registered source scope`);
  }
  const meta = request.meta && typeof request.meta === 'object' ? request.meta : {};
  if (typeof meta.asin === 'string' && meta.asin !== '' && basics.path !== `/dp/${meta.asin}`) {
    throw connectorError('request_meta_mismatch', 'request.meta.asin does not match the canonical request.url path');
  }
  return { url: basics.url, host: basics.host, path: basics.path, protocol: basics.protocol };
}

/**
 * Response-declared source/final URLs must agree with the request target; any target change
 * (redirect) is refused — this build never follows redirects automatically.
 */
function assertResponseSource(request, response, source) {
  if (!response || typeof response !== 'object') throw connectorError('response_invalid', 'transport response must be an object');
  const declaredSource = response.sourceUrl;
  if (declaredSource !== undefined && declaredSource !== null && String(declaredSource) !== String(request.url)) {
    throw connectorError('response_source_mismatch', 'response.sourceUrl does not match the request target');
  }
  const finalUrl = response.finalUrl;
  if (finalUrl !== undefined && finalUrl !== null && String(finalUrl) !== '') {
    if (String(finalUrl) !== String(request.url)) {
      assertRedirectAllowed(request.url, String(finalUrl), source); // precise codes for cross-host/protocol/path
      throw connectorError('response_final_url_changed', 'a redirect that changes the target cannot produce a normal observation');
    }
  }
  return true;
}

module.exports = { PRIVATE_HOST_RE, parseUrlBasics, parseAndCheckUrl, assertRedirectAllowed, assertRequestTarget, assertResponseSource };
