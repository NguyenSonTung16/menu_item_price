# AI usage log

The assignment permits using an assistant and asks that assistance be disclosed. Codex was used for the following work:

- Read and summarized the assignment rubric, starter README/code, and the session 4 slides.
- Prepared `IA2_IMPLEMENTATION_PLAN.md` in the parent workspace and translated the plan into the repository's `MIGRATION.md` and `README.md`.
- Implemented the v2 dual-write/API, v3 integer-read/dual-write, and v4 integer-only application code; migrations 002/003 and down files; a restartable batched backfill; canonical-column checker; mutable traffic control; tests; a tagged-version launcher; and this disclosure.
- Ran `npm test`, migration up/down checks, and the full rehearsal described in `check-rehearsal-*.txt` and `traffic-rehearsal-*.txt`. The official hand-in run is recorded separately in `check-log.txt` and `traffic-log.txt`.

## Conversation record

The following is a summary of Codex assistance in the IA#2 conversation recorded in the Codex session file `rollout-2026-10-10T07-52-36-01a1234c-2b19-7e92-9bfc-1f79deefcd0a.jsonl` (2026-10-10). It is a summary of the exchange, not a verbatim transcript:

- Explained the assignment, then clarified that old and new application versions must overlap during deployment while requests continue to succeed; compatibility includes correct prices, not just HTTP 200 responses.
- Summarized the expand, dual-write, backfill, switch-read, stop-writing-old-column, and drop-old-column sequence, along with the rollback boundary.
- Helped compare the implementation and submission evidence with the rubric, set the requested self-assessment total to 92, and discussed the required repository archive contents.
- Helped diagnose and replace an empty ZIP archive, then updated this disclosure using the conversation record.

The session JSONL is stored in the user's local Codex data directory and is not copied into the submission. The summary above records the relevant AI assistance without including unrelated conversation data or image payloads.

The student should review the code and logs, understand the migration order and rollback boundary, replace the student ID/score in the ZIP name, and submit the repository ZIP. No traffic, test, or score result should be claimed unless it appears in the checked-in evidence.
