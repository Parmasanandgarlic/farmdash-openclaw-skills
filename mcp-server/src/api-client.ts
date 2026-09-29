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
    return {
      ok: false,
      error: err.code,
      code: err.code,
      message: err.message,
      status: err.status,
      retryable: err.retryable,
      request_id: err.requestId ?? requestIdFactory(),
      details: err.details,
    };
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

export function createApiFetch(config: ApiFetchConfig) {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const requestIdFactory = config.requestIdFactory ?? randomUUID;
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 15_000;
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  let scoutGrant = config.scoutGrant?.trim() ?? '';

  return async function apiFetch(path: string, opts: ApiFetchOptions = {}): Promise<unknown> {
    const adapterRequestId = requestIdFactory();
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': config.userAgent ?? 'farmdash-mcp-server/5.0.0',
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    if (scoutGrant) headers['X-FarmDash-Scout-Grant'] = scoutGrant;
    if (config.skillId && /^[a-zA-Z0-9-]{1,128}$/.test(config.skillId)) headers['X-ClawHub-Skill'] = config.skillId;
    if (opts.sessionToken) headers['X-FarmDash-Session-Token'] = opts.sessionToken;
    if (opts.body) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeout ?? defaultTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body,
        signal: controller.signal,
      });
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
