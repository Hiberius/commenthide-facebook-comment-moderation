// The storage layer's public surface. Consumers import "../lib/storage", which
// re-exports this file; the split below only exists to keep each module small.

export { getSetting, setSetting, deleteSetting } from "./settings";

export {
  listPosts,
  listActivePosts,
  getPost,
  upsertPost,
  updatePost,
  deletePost,
  bumpPostCounters,
  touchPostChecked,
  type UpsertPostInput,
  markBaselined,
} from "./posts";

export {
  listRules,
  listAllRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  bumpRuleHits,
  seedDefaultRules,
  type RuleInput,
} from "./rules";

export {
  getComment,
  getComments,
  recordComment,
  listComments,
  listCommentsByStatus,
  markRestored,
  countByStatus,
  type RecordCommentInput,
  claimComment,
  recordFailedAttempt,
} from "./comments";

export { logEvent, recentEvents, type EventInput } from "./events";

export {
  getAuthLock,
  recordAuthFailure,
  clearAuthFailures,
  AUTH_MAX_FAILURES,
  AUTH_WINDOW_MS,
  AUTH_LOCK_MS,
  type AuthLock,
} from "./auth";

export { pruneHistory, globalTotals } from "./maintenance";
