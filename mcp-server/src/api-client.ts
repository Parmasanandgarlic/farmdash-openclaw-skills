import { randomUUID } from 'node:crypto';

export class McpApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpApiError';
  }
}

export function errorPayload(err: unknown, requestIdFactory: () => string = randomUUID) {
  if (err instanceof McpApiError) {
    const payload: Record<string, unknown> = {
      ok: false,
      error: err.code,
      code: err.code,
      message: err.message,
      status: err.status,
      retryable: err.retryable,
      request_id: err.requestId ?? requestIdFactory(),
      details: err.details,
    };
    const body = err.details && typeof err.details === 'object' && !Array.isArray(err.details)
      ? err.details as Record<string, unknown>
      : {};
    // Commercial challenges: surface the fields an agent acts on at the money
    // boundary instead of making it dig through details. Only fields the served
    // body actually carries are surfaced — never invented (the OpenAPI spec
    // example and the live body differ; the served shape is the source).
    if (err.status === 402) {
      for (const field of ['payment_options', 'entitlement_version', 'feature_entitlements', 'next_action', 'quota', 'rate_limit', 'upgrade_url', 'api_key_url', 'instruction', 'retry_same_request']) {
        if (body[field] !== undefined) payload[field] = body[field];
      }
    }
    if (err.status === 401 && err.code === 'execution_trial_identity_required') {
      const nested = body.details as Record<string, unknown> | undefined;
      if (nested && nested.execution_trial_challenge !== undefined) payload.execution_trial_challenge = nested.execution_trial_challenge;
      payload.sign_and_retry_with = 'executionTrialProof';
    }
    if (err.status === 429) {
      const retryAfterMs = body.retryAfterMs ?? body.retry_after_ms
        ?? (typeof body.resetInSeconds === 'number' && Number.isFinite(body.resetInSeconds) ? body.resetInSeconds * 1000 : undefined);
      if (retryAfterMs !== undefined) payload.retryAfterMs = retryAfterMs;
    }
    return payload;
  }

  return {
    ok: false,
    error: 'mcp_tool_error',
    code: 'mcp_tool_error',
    message: err instanceof Error ? err.message : String(err),
    status: 500,
    retryable: false,
    request_id: requestIdFactory(),
  };
}

export interface ApiFetchConfig {
  baseUrl: string;
  apiKey: string;
  defaultTimeoutMs?: number;
  requestIdFactory?: () => string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  scoutGrant?: string;
  skillId?: string;
  installationId?: string;
  clientVersion?: string;
  skillVersion?: string;
  /** Overrides FARMDASH_MCP_CACHE_TTL_MS for the safe-read cache. <= 0 disables it. */
  cacheTtlMs?: number;
}

export interface ApiFetchOptions {
  method?: string;
  body?: string;
  timeout?: number;
  sessionToken?: string;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function responseRequestId(response: Response, fallback: string): string {
  return response.headers.get('x-request-id') || fallback;
}

function requestPathPart(path: string): string {
  return path.split(/[?#]/, 1)[0];
}

function normalizedPathPart(path: string): string {
  const raw = requestPathPart(path);
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------------------------------------------ *
 * Session credential retention (process lifetime only).
 * ------------------------------------------------------------------ */

/**
 * Convenience retention only: it grants NO authority and the FarmDash backend
 * still authenticates every request. Never persisted, never logged.
 */
export interface SessionCredentials {
  sessionId?: string;
  agentAddress?: string;
  sessionToken: string;
  expiresAt?: number;
}

export interface RetainedSession {
  sessionId: string;
  agentAddress: string;
  sessionToken: string;
  retainedAt: number;
  expiresAt?: number;
}

let retainedSessionState: RetainedSession | undefined;

function nonEmptyString(value: unknown, minLength = 1): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length >= minLength ? trimmed : undefined;
}

function asEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : undefined;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Retain a session token for the life of this process. Best effort: an
 * unusable token (missing or shorter than the tool schema's 32-char minimum)
 * is ignored and leaves any previously retained session untouched.
 */
export function rememberSession(credentials: SessionCredentials): Readonly<RetainedSession> | undefined {
  if (!credentials || typeof credentials !== 'object') return undefined;
  const sessionToken = nonEmptyString(credentials.sessionToken, 32);
  if (!sessionToken) return undefined;
  const expiresAt = asEpochMs(credentials.expiresAt);
  const retained: RetainedSession = Object.freeze({
    sessionId: nonEmptyString(credentials.sessionId) ?? '',
    agentAddress: nonEmptyString(credentials.agentAddress) ?? '',
    sessionToken,
    retainedAt: Date.now(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
  retainedSessionState = retained;
  return retained;
}

export function retainedSession(): Readonly<RetainedSession> | undefined {
  const state = retainedSessionState;
  return state ? Object.freeze({ ...state }) : undefined;
}

export function clearRetainedSession(): void {
  retainedSessionState = undefined;
}

/** Missing/invalid expiresAt is treated as not expired. */
export function isSessionExpired(now: number = Date.now()): boolean {
  const state = retainedSessionState;
  if (!state) return false;
  if (typeof state.expiresAt !== 'number' || !Number.isFinite(state.expiresAt)) return false;
  return now >= state.expiresAt;
}

function activeRetainedSessionToken(): string | undefined {
  const state = retainedSessionState;
  if (!state || isSessionExpired()) return undefined;
  return state.sessionToken;
}

function pickSessionField(body: Record<string, unknown>, camel: string, snake: string): unknown {
  const nested = body.session && typeof body.session === 'object' && !Array.isArray(body.session)
    ? body.session as Record<string, unknown>
    : undefined;
  for (const candidate of [body[camel], body[snake], nested?.[camel], nested?.[snake]]) {
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

/**
 * Best-effort retention from a successful session create/heartbeat response.
 * Any unexpected shape is ignored so the caller always receives the API result
 * unchanged.
 */
function retainSessionFromResponse(parsed: unknown): void {
  try {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const body = parsed as Record<string, unknown>;
    const sessionToken = nonEmptyString(pickSessionField(body, 'sessionToken', 'session_token'), 32);
    if (!sessionToken) return;
    rememberSession({
      sessionId: nonEmptyString(pickSessionField(body, 'sessionId', 'session_id')),
      agentAddress: nonEmptyString(pickSessionField(body, 'agentAddress', 'agent_address')),
      sessionToken,
      expiresAt: asEpochMs(pickSessionField(body, 'expiresAt', 'expires_at')),
    });
  } catch {
    /* Retention is best effort and must never change the API result. */
  }
}

function sessionRequestBodyAction(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return nonEmptyString((parsed as Record<string, unknown>).action)?.toLowerCase();
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Short-TTL cache for safe read requests.
 * ------------------------------------------------------------------ */

interface ReadCacheEntry {
  value: unknown;
  expiresAt: number;
}

interface ReadCacheState {
  entries: Map<string, ReadCacheEntry>;
  hits: number;
  misses: number;
}

const READ_CACHE_MAX_ENTRIES = 200;
const READ_CACHE_DEFAULT_TTL_MS = 20_000;
// Paths whose response depends on live session/authority state must never be
// replayed from a cache, even inside the TTL window.
const READ_CACHE_DENY_PATHS: ReadonlySet<string> = new Set([
  '/v1/agent/session',
  '/v1/agent/stream',
  '/v1/agent/events',
  '/v1/agent/authority',
  '/v1/agent/context',
  '/v1/agent/receipts',
  '/v1/agent/status',
  '/v1/agent/onboard',
  '/v1/agent/autopilot',
  '/v1/agent/virtuals-acp',
  '/v1/agent/intents',
]);
// One state object per apiFetch instance: two clients with different baseUrl or
// apiKey can never share entries. The registry exists only so tests can inspect
// and clear the caches this module created.
const readCacheStates = new Set<ReadCacheState>();

function registerReadCacheState(): ReadCacheState {
  const state: ReadCacheState = { entries: new Map<string, ReadCacheEntry>(), hits: 0, misses: 0 };
  readCacheStates.add(state);
  return state;
}

export function clearReadCache(): void {
  for (const state of readCacheStates) {
    state.entries.clear();
    state.hits = 0;
    state.misses = 0;
  }
}

export function readCacheStats(): { entries: number; hits: number; misses: number } {
  let entries = 0;
  let hits = 0;
  let misses = 0;
  for (const state of readCacheStates) {
    entries += state.entries.size;
    hits += state.hits;
    misses += state.misses;
  }
  return { entries, hits, misses };
}

function resolveCacheTtlMs(override: number | undefined): number {
  if (typeof override === 'number' && Number.isFinite(override)) return Math.trunc(override);
  const raw = process.env.FARMDASH_MCP_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return READ_CACHE_DEFAULT_TTL_MS;
}

function isCacheableRead(method: string, path: string, body: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (typeof body === 'string' && body.length > 0) return false;
  return !READ_CACHE_DENY_PATHS.has(normalizedPathPart(path));
}

function writeReadCache(state: ReadCacheState, key: string, value: unknown, ttlMs: number): void {
  if (ttlMs <= 0) return;
  if (!state.entries.has(key) && state.entries.size >= READ_CACHE_MAX_ENTRIES) {
    const oldest = state.entries.keys().next();
    if (!oldest.done) state.entries.delete(oldest.value);
  }
  // Store a clone so a caller mutating the response it received cannot corrupt
  // the cached entry.
  state.entries.set(key, { value: cloneJsonValue(value), expiresAt: Date.now() + ttlMs });
}

export function createApiFetch(config: ApiFetchConfig) {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const requestIdFactory = config.requestIdFactory ?? randomUUID;
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 15_000;
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  let scoutGrant = config.scoutGrant?.trim() ?? '';
  const readCache = registerReadCacheState();

  return async function apiFetch(path: string, opts: ApiFetchOptions = {}): Promise<unknown> {
    const adapterRequestId = requestIdFactory();
    const requestMethod = opts.method ?? 'GET';
    const methodKey = requestMethod.toUpperCase();
    const cacheable = isCacheableRead(methodKey, path, opts.body);
    const cacheTtlMs = resolveCacheTtlMs(config.cacheTtlMs);
    // An explicit token always wins over the retained-session fallback.
    const effectiveSessionToken = opts.sessionToken || activeRetainedSessionToken() || '';
    // The effective session token is part of the key: two callers holding
    // different credentials in one process must never read each other's cached
    // response.
    const cacheKey = `${methodKey}\n${path}\n${effectiveSessionToken}`;
    if (cacheable && cacheTtlMs > 0) {
      const cached = readCache.entries.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        readCache.hits += 1;
        return cloneJsonValue(cached.value);
      }
      if (cached) readCache.entries.delete(cacheKey);
      readCache.misses += 1;
    }
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': config.userAgent ?? 'farmdash-mcp-server/5.0.0',
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    if (config.installationId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(config.installationId)) {
      headers['X-FarmDash-Installation-ID'] = config.installationId.toLowerCase();
      headers['X-FarmDash-Client'] = 'mcp';
    }
    if (config.clientVersion && /^[A-Za-z0-9._+-]{1,64}$/.test(config.clientVersion)) headers['X-FarmDash-Client-Version'] = config.clientVersion;
    if (config.skillVersion && /^[A-Za-z0-9._+-]{1,64}$/.test(config.skillVersion)) headers['X-FarmDash-Skill-Version'] = config.skillVersion;
    if (scoutGrant) headers['X-FarmDash-Scout-Grant'] = scoutGrant;
    if (config.skillId && /^[a-zA-Z0-9-]{1,128}$/.test(config.skillId)) headers['X-ClawHub-Skill'] = config.skillId;
    // An explicit token always wins. Retained-session fallback applies only when
    // no token was supplied, and never when the retained session has expired.
    if (opts.sessionToken) headers['X-FarmDash-Session-Token'] = opts.sessionToken;
    else {
      const retainedToken = activeRetainedSessionToken();
      if (retainedToken) headers['X-FarmDash-Session-Token'] = retainedToken;
    }
    if (opts.body) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeout ?? defaultTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: requestMethod,
        headers,
        body: opts.body,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
        try { void response.body?.cancel().catch(() => undefined); } catch { /* Security failure must remain terminal. */ }
        throw new McpApiError('redirect_policy_blocked', 'FarmDash requests do not follow redirects.', 0, false, adapterRequestId);
      }
      const requestId = responseRequestId(response, adapterRequestId);
      const contentType = response.headers.get('content-type') ?? '';

      if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
        throw new McpApiError(
          'unexpected_content_type',
          `FarmDash API returned ${contentType || 'no Content-Type header'} instead of JSON.`,
          response.ok ? 502 : response.status,
          response.ok || response.status >= 500,
          requestId,
        );
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new McpApiError(
          'unexpected_response_shape',
          'FarmDash API returned malformed JSON.',
          response.ok ? 502 : response.status,
          response.ok || response.status >= 500,
          requestId,
        );
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new McpApiError(
          'unexpected_response_shape',
          'FarmDash API returned a non-object JSON payload.',
          response.ok ? 502 : response.status,
          response.ok || response.status >= 500,
          requestId,
        );
      }

      if (!response.ok) {
        const body = parsed as Record<string, unknown>;
        const nestedError = body.error && typeof body.error === 'object'
          ? body.error as Record<string, unknown>
          : undefined;
        const code = firstString(body.code, nestedError?.code, body.error) ?? 'http_error';
        const message = firstString(body.message, nestedError?.message)
          ?? response.statusText
          ?? 'FarmDash API request failed.';
        throw new McpApiError(
          code,
          message,
          response.status,
          typeof body.retryable === 'boolean'
            ? body.retryable
            : response.status >= 500 || response.status === 429,
          firstString(body.request_id, nestedError?.request_id) ?? requestId,
          body,
        );
      }

      // Session create/heartbeat responses carry credentials the operator would
      // otherwise have to re-paste; keep them only for this process.
      if (methodKey === 'POST' && normalizedPathPart(path) === '/v1/agent/session') {
        const action = sessionRequestBodyAction(opts.body);
        if (action === 'create' || action === 'heartbeat') retainSessionFromResponse(parsed);
      }

      if (cacheable && response.status === 200) writeReadCache(readCache, cacheKey, parsed, cacheTtlMs);

      // The long-lived stdio process retains an onboarding grant only in
      // memory and attaches it to subsequent discovery calls.
      if (path.split(/[?#]/, 1)[0] === '/v1/agent/onboard') {
        const body = parsed as Record<string, unknown>;
        const acquisition = body.scout_acquisition;
        if (acquisition && typeof acquisition === 'object' && !Array.isArray(acquisition)) {
          const token = (acquisition as Record<string, unknown>).token;
          if (typeof token === 'string' && /^fd_scout_acq_[A-Za-z0-9_-]{32,64}$/.test(token)) {
            scoutGrant = token;
          }
        }
      }

      return parsed;
    } catch (err) {
      if (err instanceof McpApiError) throw err;
      const errorName = err && typeof err === 'object' && 'name' in err
        ? String((err as { name?: unknown }).name)
        : '';
      if (controller.signal.aborted || errorName === 'AbortError') {
        throw new McpApiError(
          'upstream_timeout',
          'FarmDash API request timed out.',
          504,
          true,
          adapterRequestId,
        );
      }
      throw new McpApiError(
        'upstream_unavailable',
        'FarmDash API could not be reached.',
        503,
        true,
        adapterRequestId,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}
