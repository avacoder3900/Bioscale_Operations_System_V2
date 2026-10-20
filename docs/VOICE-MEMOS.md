# VOICE-01 — Voice memos (Voicenotes → BIMS → Claude digests)

Spoken end-of-day and experiment memos, recorded in the **Voicenotes** app, delivered to BIMS by
webhook, and turned into readable digests by Claude over the BIMS MCP. People read the digests at
**Kanban → Journal**, not the transcripts.

```
Voicenotes (per-person account)
   │ webhooks: Creating Notes + Updating Notes (+ Deleting Notes)
   ▼
POST /api/webhooks/voicenotes?key=<per-person secret>
   │ key → speaker · allowlist (tag OR spoken lead-in) · idempotent upsert
   ▼
voice_memos            (the record: transcript never overwritten, no delete)
   │ MCP: voice_memos_list / voice_memos_get
   ▼
Claude + BIMS context  (board, tasks, SPUs, lots, runs)
   │ MCP: voice_memo_digest_write
   ▼
voice_memo_digests  →  /kanban/journal
```

v1 scope (decided 2026-10-19): **one speaker (jacobq)**, **manual processing** ("process my EODs"
in Claude), **digests only**: no kanban captures, proposals, or updates come from memos during
the first ~week of collection. The digest tool's description tells Claude this.

## Pieces

| Piece | Where |
|---|---|
| Webhook receiver | `src/routes/api/webhooks/voicenotes/+server.ts` |
| Payload parser + allowlist (pure, tested) | `src/lib/server/voice-memos/parse.ts` |
| Per-person keys | `src/lib/server/voice-memos/keys.ts` |
| Create / update / delete rules | `src/lib/server/voice-memos/ingest.ts` |
| Models | `src/lib/server/db/models/voice-memo.ts` (`voice_memos`, `voice_memo_digests`, `voice_memo_captures`) |
| Agent API (what MCP calls) | `src/routes/api/agent/voice-memos/**` |
| MCP tools | `voice_memos_list`, `voice_memos_get`, `voice_memo_digest_write`, `voice_memo_digests_list`, `voice_memos_mark_processed`, `voice_memos_annotate` (server 3.13.0) |
| Journal page | `src/routes/kanban/journal/` (tab in KanbanNav) |
| Digest markdown renderer (escape-first) | `src/lib/server/voice-memos/markdown.ts` |
| Operator script | `scripts/voice-memos.ts` (`captures`, `memos`, `indexes`, `key`) |

## Environment (Vercel, Production)

| Var | Value | Notes |
|---|---|---|
| `VOICENOTES_WEBHOOK_KEYS` | `jacobq:<secret>` | Comma-separated `username:secret`. Generate with `npx tsx scripts/voice-memos.ts key`. Required: without it every request is 401. |
| `VOICENOTES_CAPTURE_RAW` | `true` for Step 0, then remove | Saves every raw webhook body (including dropped personal notes) to `voice_memo_captures`, TTL 14 days. |
| `VOICENOTES_TAGS` | optional, default `eod,exp-*` | Allowlisted tags; `*` suffix = prefix match. |
| `VOICENOTES_SPOKEN_TRIGGERS` | optional, default on | `false` = only tags qualify. |

## Rollout runbook

1. **Merge + deploy** `feat/voice-memos` → `master` (GitHub → Vercel). Set the env vars above
   first (or redeploy after setting them).
2. **Indexes:** `npx tsx scripts/voice-memos.ts indexes` (idempotent). The unique index on
   `sourceNoteId` is the duplicate-delivery guard.
3. **Check the URL** in a browser:
   `https://<bims-domain>/api/webhooks/voicenotes?key=<secret>` → `{"ok":true,"speaker":"jacobq"}`.
4. **Voicenotes:** profile → Integrations → Webhooks → Add Webhook. URL = the one above. Events:
   **Creating Notes**, **Updating Notes**, **Deleting Notes**.
5. **Step 0, capture the real payload:** record
   - a note that starts "EOD …" with the `eod` tag,
   - an untagged note about something personal,
   - then edit one note (and re-save today's first EOD so it arrives as an update).

   Run `npx tsx scripts/voice-memos.ts captures 10` and check, against `parse.ts`:
   - field names for id / title / transcript / tags / created time,
   - whether **tags** are in the payload at all (the documented sample has none),
   - whether an audio URL appears,
   - which event names update and delete use.

   Tighten `parseVoicenotesPayload` if anything differs, then `npx tsx scripts/voice-memos.ts memos`
   should show the EOD stored and the personal note absent.
6. **Turn capture off:** remove `VOICENOTES_CAPTURE_RAW` (the TTL clears old captures in 14 days,
   or drop `voice_memo_captures` by hand).
7. **Process:** in Claude (BIMS connector), say "process my EODs". Claude lists unprocessed memos,
   reads them, pulls BIMS context, and files a digest. Read it at Kanban → Journal.

## Rules worth knowing

- **Allowlist:** a note is stored only if it carries an allowed tag or opens with a spoken
  lead-in: "EOD…", "E.O.D…", "End of day…" → `eod`; "Experiment 358…" / "Exp 358-B…" → `experiment`
  (the ref must contain a digit). Voicenotes auto-titles from the first words, so starting the
  memo with "EOD" is enough even if tags never reach the webhook.
- **Dropped notes** get 200 and are not stored. The only trace is a one-line log with no content.
  The one exception is while `VOICENOTES_CAPTURE_RAW=true`.
- **Tagged later:** an untagged note that gets tagged arrives as an update and is stored then.
- **Edits:** the previous title/transcript/tags move to `revisions[]`; a changed transcript reopens a
  processed memo so the digest gets rewritten (with `replacesDigestId`, which keeps the old version).
- **Deletes:** flagged (`sourceDeletedAt`), never removed.
- **Ownership:** a memo can only be changed through the key that first delivered it.
- **Journal privacy:** everyone with `kanban:read` sees digests. Source transcripts are visible only
  to their speaker and to admins.

## Open after Step 0

- Is the transcript complete at "created", or does it finish later (an update)? The update path
  handles both.
- Audio: if the payload has an expiring audio URL, add an R2 copy (`src/lib/server/r2.ts`).
  Today `audioUrl` is stored as delivered.
- After a week of digests: decide what, if anything, should flow into kanban (likely a reviewed
  `progress` proposal type; `kanban_propose_changes` only does split/merge/enrich today).
