// ═══════════════════════════════════════════════════════════════
// src/services/post-status.js — post status transition policy
// ═══════════════════════════════════════════════════════════════
// Single source of truth for which status transitions a USER may
// initiate. Before this module the rules were scattered across each
// mutating function (setPostScheduled accepted {draft,pending},
// updatePost accepted {pending}, approve/reject accepted {pending}),
// which is how 'scheduled' silently became a one-way street.
//
// Full lifecycle (for reference — not all edges are user-initiated):
//
//   draft ──────────► pending_approval ──────────► approved ──► (publish)
//     ▲   ◄──────────       ▲    │  ◄──────────                    │
//     │                     │    └──► rejected                      ▼
//     └──────► scheduled ◄──┘                                    posted
//                  │  ▲ (reschedule)                            / failed
//                  ▼  └── back to draft / queue                  / blocked
//             publishing ──► posted / failed / blocked
//                (batch publisher only)
//
//   failed ─────────► pending_approval   (4.25111.45: recovery edge)
//
//   pending_approval ► publishing        (4.25111.60: the automated
//                (auto-post only)          approval, performed only by
//                                          automation/publishing-loop.js
//                                          after the review window; the
//                                          trail line is post_auto_approved
//                                          with the mode as the actor)
//
// canTransition() governs only the USER-INITIATED set: free movement
// among the three PRE-PUBLICATION states. The approval edges
// (→approved, →rejected), the publisher edge (scheduled→publishing),
// and the terminal writes (→posted/failed/blocked) are performed by
// their own dedicated paths (approvePost / rejectPost / the batch
// publisher) and are intentionally NOT reachable through the generic
// status endpoint — a client must not be able to skip approval or
// fake a publish by requesting a status.
//
// 4.25111.45: canTransition() additionally governs the RECOVERY edges
// listed below, which are user-initiated moves OUT of a failure
// state back INTO the pre-publication set.
//
// 4.25111.45 recovery. A 'failed' post is a publish attempt that the
// destination refused (expired token, missing credentials, a
// LinkedIn rejection); its content is intact and the row already
// counts as editable below. Before this edge the state was a dead
// end: the card offered Publish and Reject, both of which the server
// refused because the post was not pending, and the generic endpoint
// refused every move. The recovery edge lets a user put the post back
// in the approval queue with one click, from where the existing
// approve path publishes it again. It is deliberately the ONLY edge
// out of 'failed': the post must pass through approval again rather
// than jump to scheduled or straight to a publish. Adding another
// recovery edge is one entry in RECOVERY, never a change to PRE_PUB.
// ═══════════════════════════════════════════════════════════════

// The pre-publication states a user may freely move a post between.
export const PRE_PUB_STATUSES = ["draft", "pending_approval", "scheduled"];

const PRE_PUB = new Set(PRE_PUB_STATUSES);

// Recovery edges: from a terminal-failure state back into the
// pre-publication set. Keyed by source status; the value is the set
// of permitted targets. Kept apart from PRE_PUB on purpose so that
// isPrePublication() and every consumer of PRE_PUB_STATUSES keep
// their meaning: a failed post is recoverable, not pre-publication.
const RECOVERY = Object.freeze({
  failed: new Set(["pending_approval"])
});

// True when `status` is one of the freely-interchangeable pre-pub states.
export function isPrePublication(status) {
  return PRE_PUB.has(status);
}

// True when a user may move a post out of `status` through a
// recovery edge (today: 'failed' only).
export function isRecoverable(status) {
  return Object.prototype.hasOwnProperty.call(RECOVERY, status);
}

// Whether a USER-initiated move from `from` to `to` is allowed.
// Any pre-pub state may move to any pre-pub state (including
// scheduled→scheduled, i.e. rescheduling), and a recoverable state
// may move to exactly its listed targets. Everything else is denied
// here and must go through a dedicated path.
export function canTransition(from, to) {
  if (PRE_PUB.has(from) && PRE_PUB.has(to)) return true;
  return isRecoverable(from) && RECOVERY[from].has(to);
}

// ── Editability ──────────────────────────────────────────────
// States in which a user may edit a post's content. Everything EXCEPT
// terminal success (posted), terminal reject (rejected), and the in-flight
// publish states: publishing (claimed by the batch publisher) and approved
// (approvePost publishes immediately in the same call, so it never rests).
// scheduled IS editable; the edit publishes at its scheduled time.
const EDITABLE = new Set(["draft", "pending_approval", "scheduled", "failed", "blocked"]);

export function isEditable(status) {
  return EDITABLE.has(status);
}
