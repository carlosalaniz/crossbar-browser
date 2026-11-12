# 0019: Fewer, clearer approval notifications

- **Status:** Accepted
- **Date:** 2026-11-11

## Decision

- **What notifies:** an agent-triggered request with consequences, an access proposal, and a challenge, only while an agent is waiting on it.
- **What doesn't:** writes a page makes on its own (`trigger: page`, usually analytics). They are held quietly, denied at the gate's timeout, and listed in Activity.
- **Merging:** further asks from the same token while a notification is unanswered replace it (one notification per agent), instead of a fixed 30-second window per user. Identical repeats join the pending ticket.
- **Wording:** who wants to do what, where; and what each choice does. Built from server-controlled fields only (AGENTS.md rule 12).
- **Actions:** Review and Deny. Approve stays in the app: a link in the notification would let anyone who can read the ntfy topic approve. The approval page opens with the default scope selected and one Approve button.
- **Default scope** for reversible classes is "for this task".
- Challenges notify once, with a reminder after 5 minutes if the agent still waits.
