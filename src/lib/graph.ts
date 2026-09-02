// CommentHide — Meta Graph API client.
//
// One instance per poll run. Target resolution is memoised on the instance, so a
// run that touches the same post repeatedly costs exactly one resolution — the
// single behaviour that stops this client from re-resolving the same post two or
// three times a minute.
//
// Transport (auth placement, retries, redaction) lives in ./graph-http; pure
// parsing and error copy live in ./graph-parse.

import type {
  ConnectionTest,
  GraphComment,
  GraphCommentsPage,
  GraphPageIdentity,
  GraphPost,
  GraphResult,
  ResolvedTarget,
} from "../types";
import { GraphTransport } from "./graph-http";
import { failedTest, isFatalAuth, normalizePostInput } from "./graph-parse";

// The contract puts these two on graph.ts; they live in graph-parse.ts only so
// every file stays under the line ceiling.
export { normalizePostInput, isRetryable } from "./graph-parse";

const POST_FIELDS = "id,message,created_time,permalink_url";
const COMMENT_FIELDS = "id,message,created_time,from,can_hide,is_hidden,comment_count";
const REPLY_FIELDS = "id,message,created_time,from,can_hide,is_hidden";

/** One huge thread must not consume a whole one-minute poll window. */
const MAX_REPLY_PARENTS = 25;

export interface GraphClientOptions {
  version?: string;
  /** Injected for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Retry attempts for retryable failures. Default 3. */
  maxRetries?: number;
  /** Injected for tests so retries do not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Sink for non-fatal problems the caller should still hear about — a single
   * unreadable reply thread, say. Additive and optional; without it those
   * failures would have to be dropped silently.
   */
  onWarning?: (message: string) => void;
  /**
   * Overrides the Graph API origin. Development and testing only — see
   * GRAPH_API_BASE in wrangler.toml.example.
   */
  apiBase?: string;
}

export interface FetchCommentsOptions {
  /** Page size, max 100. Default 100. */
  limit?: number;
  /** Follow paging.next up to this many pages. Default 3. */
  maxPages?: number;
  /** Also fetch replies for comments whose comment_count > 0. Default false. */
  includeReplies?: boolean;
}

export class GraphClient {
  private readonly token: string;
  private readonly http: GraphTransport;
  private readonly onWarning: (message: string) => void;

  // Memoised promises, not values: concurrent callers share one in-flight request.
  private readonly targets = new Map<string, Promise<GraphResult<ResolvedTarget>>>();
  private identityPromise: Promise<GraphResult<GraphPageIdentity>> | null = null;
  private pageTokensPromise: Promise<GraphResult<ReadonlyMap<string, string>>> | null = null;

  constructor(token: string, opts: GraphClientOptions = {}) {
    this.token = token;
    this.http = new GraphTransport(token, opts);
    this.onWarning = opts.onWarning ?? (() => undefined);
  }

  async identity(): Promise<GraphResult<GraphPageIdentity>> {
    this.identityPromise ??= this.http.call<GraphPageIdentity>("me", {
      token: this.token,
      query: { fields: "id,name" },
    });
    const result = await this.identityPromise;
    if (!result.ok && result.retryable === true) this.identityPromise = null;
    return result;
  }

  /** Accepts a numeric id, PAGEID_POSTID, or a facebook.com post URL. */
  async resolveTarget(postInput: string): Promise<GraphResult<ResolvedTarget>> {
    const cached = this.targets.get(postInput);
    if (cached !== undefined) return cached;
    const pending = this.doResolve(postInput);
    this.targets.set(postInput, pending);
    const result = await pending;
    // Remember permanent answers; a transient blip must not poison the whole run.
    if (!result.ok && result.retryable === true) this.targets.delete(postInput);
    return result;
  }

  async getPost(target: ResolvedTarget): Promise<GraphResult<GraphPost>> {
    return this.http.call<GraphPost>(target.postId, {
      token: target.accessToken,
      query: { fields: POST_FIELDS },
    });
  }

  async listRecentPosts(pageId?: string, limit = 25): Promise<GraphResult<GraphPost[]>> {
    const token = await this.tokenFor(pageId);
    if (!token.ok) return token;
    const path = pageId === undefined || pageId === "" ? "me/posts" : `${pageId}/posts`;
    const res = await this.http.call<{ data?: GraphPost[] }>(path, {
      token: token.data,
      query: { fields: POST_FIELDS, limit: Math.min(Math.max(limit, 1), 100) },
    });
    return res.ok ? { ok: true, data: res.data.data ?? [] } : res;
  }

  async fetchComments(
    target: ResolvedTarget,
    opts: FetchCommentsOptions = {},
  ): Promise<GraphResult<GraphComment[]>> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 100);
    const maxPages = Math.max(opts.maxPages ?? 3, 1);
    const collected: GraphComment[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < maxPages; page += 1) {
      const res: GraphResult<GraphCommentsPage> =
        cursor === null
          ? await this.http.call<GraphCommentsPage>(`${target.postId}/comments`, {
              token: target.accessToken,
              query: {
                filter: "stream",
                order: "reverse_chronological",
                limit,
                fields: COMMENT_FIELDS,
              },
            })
          : await this.http.call<GraphCommentsPage>(cursor, { token: target.accessToken });
      if (!res.ok) return res;

      const batch = res.data.data ?? [];
      if (batch.length === 0) break; // Empty page — nothing left to walk.
      for (const comment of batch) {
        if (seen.has(comment.id)) continue;
        seen.add(comment.id);
        collected.push(comment);
      }
      // Annotated because `cursor` feeds the request that produced it, and TS
      // would otherwise call the inference circular.
      const next: string | undefined = res.data.paging?.next;
      if (next === undefined || next === "") break;
      cursor = next;
    }

    if (opts.includeReplies !== true) return { ok: true, data: collected };
    return this.withReplies(collected, target);
  }

  async setHidden(
    target: ResolvedTarget,
    commentId: string,
    hidden: boolean,
  ): Promise<GraphResult<{ success: boolean }>> {
    const res = await this.http.call<{ success?: boolean }>(commentId, {
      token: target.accessToken,
      method: "POST",
      form: { is_hidden: hidden ? "true" : "false" },
    });
    // Graph answers {"success":true}; treat anything that is not an explicit
    // false as success, since some edges answer with the object id instead.
    return res.ok ? { ok: true, data: { success: res.data.success !== false } } : res;
  }

  async testConnection(postInput: string): Promise<ConnectionTest> {
    const target = await this.resolveTarget(postInput);
    if (!target.ok) return failedTest(target, "resolve", {});

    const context = { postId: target.data.postId, pageId: target.data.pageId };
    const post = await this.getPost(target.data);
    if (!post.ok) return failedTest(post, "post_lookup", context);

    const comments = await this.fetchComments(target.data, { limit: 5, maxPages: 1 });
    if (!comments.ok) return failedTest(comments, "comment_read", context);

    return {
      ok: true,
      ...context,
      permalinkUrl: post.data.permalink_url,
      sampleComments: comments.data.length,
    };
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private async doResolve(postInput: string): Promise<GraphResult<ResolvedTarget>> {
    const normalized = normalizePostInput(postInput);
    if (normalized === "") {
      return this.http.fail(0, "empty_post_id", "No post id was supplied. Paste a post URL or a PAGEID_POSTID value.");
    }
    if (/^pfbid/i.test(normalized)) {
      return this.http.fail(
        0,
        "opaque_post_id",
        "That link uses Facebook's opaque pfbid format, which the Graph API cannot resolve. " +
          "Pick the post from the Recent Posts list instead, or paste its numeric PAGEID_POSTID.",
      );
    }

    const me = await this.identity();
    if (!me.ok) return me;

    // A bare id is only half the pair; the token's own object supplies the rest.
    const postId = normalized.includes("_") ? normalized : `${me.data.id}_${normalized}`;
    const pageId = postId.slice(0, postId.indexOf("_"));
    if (pageId === "") {
      return this.http.fail(0, "invalid_post_id", `"${normalized}" is not a usable post id. Expected PAGEID_POSTID.`);
    }

    const token = await this.tokenFor(pageId);
    if (!token.ok) return token;
    return { ok: true, data: { input: postInput, postId, pageId, accessToken: token.data } };
  }

  /** The Page token for pageId, falling back to the caller's own token. */
  private async tokenFor(pageId?: string): Promise<GraphResult<string>> {
    if (pageId === undefined || pageId === "") return { ok: true, data: this.token };
    const me = await this.identity();
    if (!me.ok) return me;
    if (me.data.id === pageId) return { ok: true, data: this.token }; // Already a Page token.

    const tokens = await this.pageTokens();
    if (!tokens.ok) {
      // /me/accounts fails for a Page token, which is itself the diagnosis:
      // this token belongs to some other Page.
      return this.http.fail(
        tokens.status,
        tokens.code ?? "page_not_managed",
        `Could not look up a Page token for Page ${pageId}: ${tokens.message} ` +
          "Use a User Access Token from an account that administers that Page, or that Page's own token.",
        tokens.retryable === true,
      );
    }
    const pageToken = tokens.data.get(pageId);
    if (pageToken === undefined) {
      return this.http.fail(
        403,
        "page_not_managed",
        `This access token does not manage Page ${pageId}. Generate the token from an account that ` +
          "administers that Page, granting pages_read_engagement and pages_manage_engagement.",
      );
    }
    return { ok: true, data: pageToken };
  }

  private async pageTokens(): Promise<GraphResult<ReadonlyMap<string, string>>> {
    this.pageTokensPromise ??= this.loadPageTokens();
    const result = await this.pageTokensPromise;
    if (!result.ok && result.retryable === true) this.pageTokensPromise = null;
    return result;
  }

  private async loadPageTokens(): Promise<GraphResult<ReadonlyMap<string, string>>> {
    const res = await this.http.call<{ data?: { id?: string; access_token?: string }[] }>("me/accounts", {
      token: this.token,
      query: { fields: "id,name,access_token", limit: 100 },
    });
    if (!res.ok) return res;
    const map = new Map<string, string>();
    for (const account of res.data.data ?? []) {
      if (account.id !== undefined && account.access_token !== undefined) {
        map.set(account.id, account.access_token);
      }
    }
    return { ok: true, data: map };
  }

  private async withReplies(
    parents: readonly GraphComment[],
    target: ResolvedTarget,
  ): Promise<GraphResult<GraphComment[]>> {
    const out = [...parents];
    const seen = new Set(parents.map((c) => c.id));
    let visited = 0;

    for (const parent of parents) {
      if (visited >= MAX_REPLY_PARENTS) break;
      if ((parent.comment_count ?? 0) <= 0) continue;
      visited += 1;

      const res = await this.http.call<GraphCommentsPage>(`${parent.id}/comments`, {
        token: target.accessToken,
        query: { fields: REPLY_FIELDS, limit: 100 },
      });
      if (!res.ok) {
        // A token/permission failure would break every later call too.
        if (isFatalAuth(res.code)) return res;
        this.onWarning(`Replies for comment ${parent.id} could not be read: ${res.message}`);
        continue;
      }
      for (const reply of res.data.data ?? []) {
        if (seen.has(reply.id)) continue;
        seen.add(reply.id);
        out.push(reply);
      }
    }
    return { ok: true, data: out };
  }
}
