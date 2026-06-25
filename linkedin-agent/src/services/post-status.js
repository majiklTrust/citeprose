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
// canTransition() governs only the USER-INITIATED set: free movement
// among the three PRE-PUBLICATION states. The approval edges
// (→approved, →rejected), the publisher edge (scheduled→publishing),
// and the terminal writes (→posted/failed/blocked) are performed by
// their own dedicated paths (approvePost / rejectPost / the batch
// publisher) and are intentionally NOT reachable through the generic
// status endpoint — a client must not be able to skip approval or
// fake a publish by requesting a status.
// ═══════════════════════════════════════════════════════════════

// The pre-publication states a user may freely move a post between.
export const PRE_PUB_STATUSES = ["draft", "pending_approval", "scheduled"];

const PRE_PUB = new Set(PRE_PUB_STATUSES);

// True when `status` is one of the freely-interchangeable pre-pub states.
export function isPrePublication(status) {
  return PRE_PUB.has(status);
}

// Whether a USER-initiated move from `from` to `to` is allowed.
// Any pre-pub state may move to any pre-pub state (including
// scheduled→scheduled, i.e. rescheduling). Everything else is denied
// here and must go through a dedicated path.
export function canTransition(from, to) {
  return PRE_PUB.has(from) && PRE_PUB.has(to);
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
