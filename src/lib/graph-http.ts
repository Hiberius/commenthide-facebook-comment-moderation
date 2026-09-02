// CommentHide — Graph API transport: URL building, auth placement, retries.
//
// Split out of graph.ts so both files stay under the 400-line ceiling, and so
// the retry/backoff behaviour can be tested without a GraphClient.
//
// Auth placement is the load-bearing detail here. GET requests carry the token
// as a Bearer header and POST requests carry it in the form body, because query
// strings are what end up in proxy logs, error reports and browser history.

import type { GraphErr, GraphResult } from "../types";
import { redact } from "./crypto";
import { backoffMs, describeThrown, explain, isRecord, isRetryable } from "./graph-parse";

const DEFAULT_VERSION = "v25.0";
const DEFAULT_API_BASE = "https://graph.facebook.com";

export interface TransportOptions {
  version?: string;
  /** Injected for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Retry attempts for retryable failures. Default 3. */
  maxRetries?: number;
  /** Injected for tests so retries do not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Overrides the Graph API origin. Intended for local development and
   * integration testing against a mock; leave unset to call Meta directly.
   */
  apiBase?: string;
}

export interface CallInit {
  token: string;
  method?: "GET" | "POST";
  query?: Record<string, string | number>;
  form?: Record<string, string>;
}

export class GraphTransport {
  private readonly base: string;
  /** Every absolute URL this client will follow must match this origin. */
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Redacted out of every outgoing message. */
  private readonly secret: string;

  constructor(secret: string, opts: TransportOptions = {}) {
    this.secret = secret;
    const root = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    this.base = `${root}/${opts.version ?? DEFAULT_VERSION}`;
    this.origin = new URL(root).origin;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = Math.max(opts.maxRetries ?? 3, 0);
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** `pathOrUrl` is either an edge path or a full paging.next URL. */
  async call<T>(pathOrUrl: string, init: CallInit): Promise<GraphResult<T>> {
    const url = this.buildUrl(pathOrUrl, init.query);
    if (url === null) {
      return this.fail(
        0,
        "foreign_origin",
        "Refused to send the access token to a URL outside the configured Graph API origin.",
      );
    }
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.attempt<T>(url, init);
      if (result.ok || result.retryable !== true || attempt >= this.maxRetries) return result;
      await this.sleep(backoffMs(attempt));
    }
  }

  /** Builds a client-side GraphErr with the same redaction guarantee. */
  fail(status: number, code: number | string | undefined, message: string, retryable = false): GraphErr {
    return {
      ok: false,
      status,
      ...(code !== undefined ? { code } : {}),
      message: redact(message, this.secret),
      retryable,
    };
  }

  private async attempt<T>(url: string, init: CallInit): Promise<GraphResult<T>> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, buildRequest(init));
    } catch (err) {
      const thrown = describeThrown(err);
      // The Workers runtime throws this when the per-invocation subrequest cap
      // is spent. Retrying can only fail again, and each attempt costs backoff
      // the rest of the run cannot afford.
      if (/too many subrequests/i.test(thrown)) {
        return this.fail(0, "subrequest_limit", `Cloudflare subrequest limit reached: ${thrown}`, false);
      }
      // Not covered by isRetryable, which mirrors the documented Graph codes —
      // but a dropped connection is exactly what a retry is for.
      return this.fail(0, undefined, `Could not reach the Graph API: ${thrown}`, true);
    }

    const raw = await res.text().catch(() => "");
    let json: unknown;
    if (raw !== "") {
      try {
        json = JSON.parse(raw) as unknown;
      } catch {
        json = undefined;
      }
    }

    const error = isRecord(json) && isRecord(json["error"]) ? json["error"] : undefined;
    if (error !== undefined || !res.ok) return this.toError(res.status, error);
    if (json === undefined) {
      return this.fail(res.status, undefined, "The Graph API returned a response that was not valid JSON.");
    }
    return { ok: true, data: json as T };
  }

  private toError(status: number, error: Record<string, unknown> | undefined): GraphErr {
    const rawCode = error?.["code"];
    const rawSub = error?.["error_subcode"];
    const rawType = error?.["type"];
    const rawMsg = error?.["message"];
    const code = typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : undefined;
    return {
      ok: false,
      status,
      ...(code !== undefined ? { code } : {}),
      ...(typeof rawSub === "number" || typeof rawSub === "string" ? { subcode: rawSub } : {}),
      ...(typeof rawType === "string" ? { type: rawType } : {}),
      message: redact(explain(status, code, typeof rawMsg === "string" ? rawMsg : ""), this.secret),
      retryable: isRetryable(status, code),
    };
  }

  /**
   * Returns null when the URL is not one this client may send a token to.
   *
   * paging.next is a fully-qualified URL that arrives inside a Graph response
   * body. Every request carries the Page token in an Authorization header, so
   * following a cursor that named another origin would hand that token to
   * whoever wrote the response. The origin is checked against the configured
   * base, which also keeps GRAPH_API_BASE safe by construction: a mock's own
   * cursors share the mock's origin.
   */
  private buildUrl(pathOrUrl: string, query?: Record<string, string | number>): string | null {
    const absolute = /^https?:\/\//i.test(pathOrUrl);
    let url: URL;
    try {
      url = new URL(absolute ? pathOrUrl : `${this.base}/${pathOrUrl.replace(/^\/+/, "")}`);
    } catch {
      return null;
    }
    if (absolute && url.origin !== this.origin) return null;
    // paging.next arrives with the token baked into the query string. Strip it —
    // URLs get logged, headers do not.
    url.searchParams.delete("access_token");
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    return url.toString();
  }
}

function buildRequest(init: CallInit): RequestInit {
  if (init.method !== "POST") {
    return {
      method: "GET",
      headers: { authorization: `Bearer ${init.token}`, accept: "application/json" },
    };
  }
  const body = new URLSearchParams(init.form ?? {});
  body.set("access_token", init.token);
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  };
}
