/**
 * Domain-scoped cookie jar.
 *
 * This module exists because of one measured failure: sending
 * `.account.xiaomi.com` and `.xiaomi.com` cookies in the same `Cookie` header
 * makes MiMo's gateway treat the session as invalid and answer every cookie
 * with `EXPIRED`, redirecting back to the passport login page. Scoping each
 * request's header to the domains that actually match the request host is what
 * makes the STS exchange succeed.
 *
 * Semantics follow RFC 6265 closely enough for this flow:
 *
 *   - a host-only cookie (no `Domain=`) is sent to exactly that host;
 *   - a domain cookie (`Domain=example.com`) is sent to that host and any
 *     subdomain;
 *   - a leading dot on the domain attribute means the same thing and is
 *     normalized away.
 *
 * @module dsh-mimo-connect/cookie-jar
 */

/** A cookie whose value means "drop this cookie". */
const CLEARED = /^(EXPIRED)?$/

/**
 * Normalize a domain for comparison: lowercase, no leading dot.
 *
 * @param domain - raw domain string.
 * @returns the normalized domain.
 */
function normalizeDomain(domain) {
  return String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
}

/**
 * Whether a cookie scoped to `domain` may be sent to `host`.
 *
 * @param domain - the cookie's domain (normalized).
 * @param host - the request host (normalized).
 * @returns true when the cookie matches.
 */
export function domainMatches(domain, host) {
  const d = normalizeDomain(domain)
  const h = normalizeDomain(host)
  if (d.length === 0 || h.length === 0) return false
  return h === d || h.endsWith(`.${d}`)
}

/**
 * Parse one `Set-Cookie` header line.
 *
 * @param line - the raw header value.
 * @param fallbackHost - host to attribute the cookie to when no Domain is given.
 * @returns the parsed cookie, or undefined when the line is unusable.
 */
export function parseSetCookie(line, fallbackHost) {
  if (typeof line !== 'string' || line.length === 0) return undefined
  const parts = line.split(';')
  const pair = parts[0] ?? ''
  const eq = pair.indexOf('=')
  if (eq <= 0) return undefined

  const name = pair.slice(0, eq).trim()
  if (name.length === 0) return undefined

  // Strip surrounding quotes; Chromium serializes empty values as "".
  let value = pair.slice(eq + 1).trim()
  const quoted = /^"(.*)"$/.exec(value)
  if (quoted !== null) value = quoted[1]

  let domain = normalizeDomain(fallbackHost)
  let hostOnly = true
  let path = '/'
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf('=')
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase()
    if (key === 'domain') {
      const raw = i === -1 ? '' : attr.slice(i + 1).trim()
      // An explicit Domain makes it a domain cookie even without a dot.
      domain = normalizeDomain(raw)
      hostOnly = false
    } else if (key === 'path') {
      const raw = i === -1 ? '' : attr.slice(i + 1).trim()
      // RFC 6265 §5.2.4: a Path that does not start with "/" is ignored, and
      // an absent/empty one defaults to "/".
      if (raw.startsWith('/')) path = raw
    }
  }
  if (domain.length === 0) return undefined

  return { domain, name, value, hostOnly, path }
}

/**
 * Whether a cookie scoped to `cookiePath` may be sent to `requestPath`.
 *
 * RFC 6265 §5.1.4 path-match: equal, or a prefix ending on a `/` boundary.
 * The boundary rule is what keeps `/admin` from matching `/administrator`.
 *
 * @param cookiePath - the cookie's Path attribute (defaults to `/`).
 * @param requestPath - the request URL's pathname.
 * @returns true when the cookie may be sent.
 */
export function pathMatches(cookiePath, requestPath) {
  const cookie = cookiePath === undefined || cookiePath === '' ? '/' : cookiePath
  const request = requestPath === undefined || requestPath === '' ? '/' : requestPath
  if (cookie === request) return true
  if (!request.startsWith(cookie)) return false
  if (cookie.endsWith('/')) return true
  return request.charAt(cookie.length) === '/'
}

/**
 * A jar of cookies keyed by domain, then by name. Last write wins, so
 * re-absorbing a refresh overwrites the previous value.
 */
export class CookieJar {
  /**
   * domain -> (name -> { value, path })
   *
   * `path` is part of the key because one host may hold two cookies of the same
   * name scoped to different paths; the browser sends the longest matching one.
   *
   * @type {Map<string, Map<string, { value: string, path: string }>>}
   */
  #byDomain = new Map()

  /**
   * Store a cookie. Empty values and the literal `EXPIRED` clear the entry:
   * the gateway uses both to revoke a session.
   *
   * @param domain - cookie domain.
   * @param name - cookie name.
   * @param value - cookie value; empty or `EXPIRED` deletes.
   * @param path - cookie Path attribute; defaults to `/`.
   */
  set(domain, name, value, path = '/') {
    const d = normalizeDomain(domain)
    if (d.length === 0) return
    let bucket = this.#byDomain.get(d)
    if (bucket === undefined) {
      bucket = new Map()
      this.#byDomain.set(d, bucket)
    }
    if (typeof value !== 'string' || CLEARED.test(value.trim())) bucket.delete(name)
    else bucket.set(name, { value, path: path.startsWith('/') ? path : '/' })
  }

  /** Read one cookie value, or undefined. */
  get(domain, name, requestPath = '/') {
    const entry = this.#byDomain.get(normalizeDomain(domain))?.get(name)
    if (entry === undefined) return undefined
    // A read for a specific path must respect that cookie's Path scope.
    return pathMatches(entry.path, requestPath) ? entry.value : undefined
  }

  /**
   * Build the `Cookie` header for one URL, including only cookies whose domain
   * and path match that URL.
   *
   * A host can legitimately match several stored domains at once — for example
   * `account.xiaomi.com` matches both `.account.xiaomi.com` and `.xiaomi.com`,
   * and in practice both carry a `cUserId`. Emitting that name twice produces
   * an invalid header (and a duplicate-cookie ambiguity on the server), so each
   * name is emitted once, taking the value from the most specific domain — the
   * longest matching domain wins, which is the rule browsers apply.
   *
   * @param url - the absolute request URL.
   * @returns the header value, or an empty string when nothing matches.
   */
  headerFor(url) {
    let host
    let path
    try {
      const parsed = new URL(url)
      host = parsed.hostname
      path = parsed.pathname === '' ? '/' : parsed.pathname
    } catch {
      return ''
    }

    // Collect matches, then resolve per-name conflicts by domain specificity.
    const matches = []
    for (const [domain, cookies] of this.#byDomain) {
      if (!domainMatches(domain, host)) continue
      matches.push({ domain, cookies })
    }
    // Most specific first, so the first write of a name is the one we keep.
    matches.sort((a, b) => b.domain.length - a.domain.length)

    const chosen = new Map()
    for (const { cookies } of matches) {
      for (const [name, entry] of cookies) {
        // A cookie whose Path does not cover this request is not sent at all;
        // this is what keeps a `/admin`-scoped cookie off `/public`.
        if (!pathMatches(entry.path, path)) continue
        if (!chosen.has(name)) chosen.set(name, entry.value)
      }
    }
    return [...chosen].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  /**
   * Absorb the `Set-Cookie` headers of one response.
   *
   * @param headers - a Headers-like object, or an array of raw header lines.
   * @param host - host the response came from, for cookies with no Domain.
   */
  absorb(headers, host) {
    const lines = Array.isArray(headers)
      ? headers
      : typeof headers?.getSetCookie === 'function'
        ? headers.getSetCookie()
        : []
    for (const line of lines) {
      const parsed = parseSetCookie(line, host)
      if (parsed === undefined) continue
      this.set(parsed.domain, parsed.name, parsed.value, parsed.path)
    }
  }

  /** Seed from `{ domain: { name: value } }`, as read from a browser DB. */
  seed(byDomain) {
    for (const [domain, cookies] of Object.entries(byDomain ?? {})) {
      for (const [name, value] of Object.entries(cookies ?? {})) {
        // Seeded rows carry no Path; `/` is the browser default and matches
        // every request path, which is what these pre-existing call sites mean.
        this.set(domain, name, value)
      }
    }
  }

  /** Every domain currently holding at least one cookie. */
  domains() {
    return [...this.#byDomain.keys()]
  }

  /** Names held for one domain (diagnostics only; never prints values). */
  namesFor(domain) {
    return [...(this.#byDomain.get(normalizeDomain(domain))?.keys() ?? [])]
  }

  /** A `{ domain: { name: value } }` snapshot; contains secrets. */
  toJSON() {
    const out = {}
    for (const [domain, cookies] of this.#byDomain) {
      out[domain] = Object.fromEntries([...cookies].map(([name, entry]) => [name, entry.value]))
    }
    return out
  }

  /** Non-secret summary for logs: `domain: [names]`. */
  describe() {
    return this.domains()
      .map(d => `${d}: [${this.namesFor(d).join(', ')}]`)
      .join(' | ')
  }
}
