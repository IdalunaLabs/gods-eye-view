import { isNonGlobalIpv4 } from '../../../src/sources/radioBrowser.js';

/**
 * Whether a resolved address is a public unicast target.
 * Rejects loopback, private, link-local, multicast, documentation, and
 * IPv4-mapped or NAT64 forms of those ranges.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPublicAddress(value) {
  const address = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!address) return false;
  if (!address.includes(':')) {
    const ipv4 = address.split('.');
    return (
      ipv4.length === 4 &&
      ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
      !isNonGlobalIpv4(address)
    );
  }
  const pieces = address.split('::');
  if (pieces.length > 2) return false;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (
    (pieces.length === 1 && missing !== 0) ||
    (pieces.length === 2 && missing < 1)
  )
    return false;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  )
    return false;
  const numeric = groups.reduce(
    (total, group) => (total << 16n) | BigInt(`0x${group}`),
    0n,
  );
  const inCidr = (base, prefix) => {
    const shift = 128n - BigInt(prefix);
    return numeric >> shift === base >> shift;
  };
  const base = (text) =>
    text
      .split(':')
      .reduce(
        (total, group) => (total << 16n) | BigInt(`0x${group || '0'}`),
        0n,
      );
  const cidr = (text, prefix) => inCidr(base(text), prefix);
  if (cidr('0:0:0:0:0:ffff:0:0', 96)) {
    const v4 =
      ((numeric >> 24n) & 0xffn).toString() +
      '.' +
      ((numeric >> 16n) & 0xffn).toString() +
      '.' +
      ((numeric >> 8n) & 0xffn).toString() +
      '.' +
      (numeric & 0xffn).toString();
    return isPublicAddress(v4);
  }
  return (
    cidr('2000:0:0:0:0:0:0:0', 3) &&
    !cidr('2001:0:0:0:0:0:0:0', 23) &&
    !cidr('2001:db8:0:0:0:0:0:0', 32) &&
    !cidr('2002:0:0:0:0:0:0:0', 16) &&
    !cidr('3fff:0:0:0:0:0:0:0', 20)
  );
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isIpLiteral(hostname) {
  const host = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!host) return false;
  if (host.includes(':')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * http(s) URL with no credentials and no literal private address.
 * Hostnames are accepted here; DNS is checked again at fetch time.
 * @param {unknown} value
 * @returns {string} The URL, or '' when it must not be registered or fetched.
 */
export function publicCctvUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  )
    return '';
  if (isIpLiteral(hostname) && !isPublicAddress(hostname)) return '';
  return url.toString();
}

/**
 * Resolve a hostname and accept it only when every address is public.
 * @param {string} hostname
 * @param {(host:string, options:object)=>Promise<object|object[]>} lookupImpl
 * @returns {Promise<Array<{address:string,family:number}>|null>}
 */
export async function resolvePublicAddresses(hostname, lookupImpl) {
  const host = String(hostname || '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!host) return null;
  if (isIpLiteral(host)) {
    if (!isPublicAddress(host)) return null;
    return [{ address: host, family: host.includes(':') ? 6 : 4 }];
  }
  let resolved;
  try {
    resolved = await lookupImpl(host, { all: true, verbatim: true });
  } catch {
    return null;
  }
  const rows = (Array.isArray(resolved) ? resolved : [resolved])
    .map((row) => ({
      address: String(row?.address || ''),
      family:
        Number(row?.family) ||
        (String(row?.address || '').includes(':') ? 6 : 4),
    }))
    .filter((row) => row.address);
  if (!rows.length || rows.some((row) => !isPublicAddress(row.address)))
    return null;
  return rows;
}
