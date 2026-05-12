# Multiplayer Remote (Sub-project #6) — Minimum Slice Design Document

> Status: approved during brainstorming on 2026-05-12. Implementation plan to follow.

## 0. Context and goals

Sub-project #5 (Campaign management) shipped — the schema is multiplayer-ready (N characters per campaign, N sessions per campaign, FK in place), the master loop reads/writes through `campaigns`, and the API surface is in place. This document specifies the **minimum slice of sub-project #6 (Multiplayer Remote)**: enable N-player synchronous play within a single campaign, with each player on their own device, sharing the same chat log and AI-driven Master.

The minimum slice prioritizes the smallest end-to-end vertical that delivers the core multiplayer value: **two or more friends in different cities playing D&D together with an AI DM**. Lobby UX, presence indicators, kick-from-party, and local pass-and-play are deferred to follow-up slices of #6.

## 1. Scope of this document

This spec covers the changes needed to ship N-player remote multiplayer in a single PR:

| Area | Change |
|---|---|
| **DB schema** | New `campaign_invites` table; 3 new columns on `sessions`; 1 new column on `session_messages`; backfill of existing rows. |
| **API routes** | New `/api/campaigns/[id]/invites` (POST/GET/DELETE), `/api/r/[token]` (GET), `/api/campaigns/[id]/join` (POST), `/api/sessions/[id]/stream` (GET, SSE). Modified: `/api/sessions/[id]/turn` (permission check + post-loop hook), `/api/sessions/[id]` (response includes party). |
| **Master loop** | New `set_current_player(characterId)` tool; party snapshot (all characters) in system prompt; fallback round-robin after 3 turns without tool call. |
| **Real-time** | SSE endpoint `/api/sessions/[id]/stream` backed by Postgres `LISTEN/NOTIFY`. Application-level `notifySession()` helper called by all writers. POST `/turn` becomes fire-and-forget; chunks broadcast via unified stream. |
| **UI** | New `/r/[token]` resolve page, `/campaigns/[id]/join` join page. Modified: `/campaigns/[id]` detail (invite section + party list), `/sessions/[id]` game screen (party strip + composer gating). Character wizard supports `?returnTo=` query param. |
| **Tests** | Test fixtures inserting `session_messages` with `role='player'` updated to include `author_character_id`. New unit/integration/E2E tests for multiplayer flows. |

PR 2 (deferred ≥1 week after stable production): add `NOT NULL` constraint on `sessions.current_player_character_id`.

Out of scope (deferred to follow-up slices of #6):
- Pre-game lobby with ready states (slice B)
- Presence indicators (slice B)
- Host kick / remove player (slice B)
- Local pass-and-play / PC switcher on single device (slice C)
- Invite per-seat single-use (slice B)
- Friend list, public room discoverability (out forever)
- Voice chat (out forever — use Discord)
- Human DM takeover (out forever)
- Spectator mode (post-#6)

## 2. High-level architecture

```
                       Campaign (existing, sub-project #5)
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
   characters       sessions        campaign_invites (NEW)
   (one instance    (1 active       opaque token, revocable,
    per player)     per campaign)   expirable, optional max_uses

   sessions extended with:
   ├─ current_player_character_id (NEW)
   │   └─ master tool set_current_player(...) OR fallback round-robin
   ├─ turn_seq (NEW, monotonic counter)
   └─ turns_since_master_advance (NEW, fallback trigger)

   session_messages extended with:
   └─ author_character_id (NEW, NULL for master/system)
```

### Architectural principles

1. **Schema preserves N=1 (solo) as a special case.** Every multiplayer addition is transparent when only one character is in the party. Existing solo campaigns continue to work without changes.
2. **Single unified SSE stream per client.** Every party member subscribes to `GET /api/sessions/[id]/stream` to receive: initial snapshot, master message chunks, state updates, turn changes, dice rolls. No separate "active player" stream — the player taking a turn watches the same stream as everyone else.
3. **Master is in charge of turn order.** Default discipline is master-decided via `set_current_player` tool. Server-side fallback round-robin only kicks in after 3 consecutive turns without a tool call (deadlock prevention).
4. **Application-level NOTIFY, not Postgres triggers.** Writers call `notifySession(sessionId, payload)` after every state mutation. Triggers would couple schema to event flow; explicit calls keep the event surface a first-class API.
5. **Atomic ownership checks.** `POST /turn` validates that the requesting user owns the character pointed at by `sessions.current_player_character_id`. Race conditions are serialized by the existing `turn_lock_holder` mechanism.
6. **Host symmetry preserved for solo flow.** Campaign create still forks the host's character (auto-join the host). Guests use the invite/join flow. Solo workflow has zero new clicks.

### Tech stack additions

- **Real-time layer**: Postgres `LISTEN/NOTIFY` + SSE. Zero new dependencies. Runs on Vercel Functions / Fluid Compute. Each SSE stream holds one dedicated pg connection.
- **Token generator**: `crypto.randomBytes(9).toString('base64url')` → 12-char URL-safe tokens. Cryptographically strong, hard to guess.
- **No new auth provider**, **no websocket server**, **no third-party pub-sub** in this slice.

## 3. Data model

### 3.1 New table `campaign_invites`

```
campaign_invites
  id                  uuid PK DEFAULT gen_random_uuid()
  campaign_id         uuid NOT NULL  REFERENCES campaigns(id) ON DELETE CASCADE
  token               text NOT NULL  UNIQUE             -- random 12-char URL-safe
  created_by_user_id  text NOT NULL  REFERENCES users(id)
  created_at          timestamptz NOT NULL DEFAULT now()
  expires_at          timestamptz                       -- NULL = never expires
  revoked_at          timestamptz                       -- NULL = active
  max_uses            integer                           -- NULL = unlimited
  uses_count          integer NOT NULL DEFAULT 0

  INDEX campaign_invites_token_idx     (token)
  INDEX campaign_invites_campaign_idx  (campaign_id)
```

**Validity check** (application-level helper):

```typescript
function isInviteValid(invite: CampaignInvite, now = new Date()): boolean {
  if (invite.revokedAt) return false;
  if (invite.expiresAt && invite.expiresAt < now) return false;
  if (invite.maxUses !== null && invite.usesCount >= invite.maxUses) return false;
  return true;
}
```

### 3.2 Changes to `sessions`

```
  current_player_character_id   uuid  REFERENCES characters(id)   -- NEW
                                       -- nullable in PR1, NOT NULL in PR2 follow-up
  turn_seq                      integer NOT NULL DEFAULT 0        -- NEW
                                       -- monotonic per-turn counter
  turns_since_master_advance    integer NOT NULL DEFAULT 0        -- NEW
                                       -- reset to 0 when master calls set_current_player
                                       -- ≥3 triggers server-side round-robin fallback
```

### 3.3 Changes to `session_messages`

```
  author_character_id  uuid REFERENCES characters(id) ON DELETE SET NULL    -- NEW
                            -- NULL for role='master'/'system'
                            -- character.id for role='player'
```

### 3.4 Application invariants

- **One character instance per player per campaign**: a user must have exactly one character with `(campaign_id = X, user_id = me)`. Enforced at `POST /join` via 409 Conflict. *Not* enforced via a DB partial unique index in this slice — application-level only. If concurrent join attempts ever race past the application check (extremely unlikely with serialized session lock), the result is a duplicate party row; resolution would be a manual cleanup. A partial unique index `(campaign_id, user_id) WHERE template_id IS NOT NULL AND deleted_at IS NULL` could be added in a follow-up if needed.
- **`current_player_character_id` references an instance in the same campaign**: enforced at the master tool handler and at fallback round-robin time.
- **Invite token uniqueness**: DB-enforced UNIQUE constraint. Collision retry on insert (extremely unlikely with 12-char URL-safe random).
- **Cascade semantics**: deleting a campaign cascades to its invites, sessions, and instance characters (already in place).

## 4. API routes

### 4.1 New routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/campaigns/[id]/invites` | POST | host | Generate new invite token. Body: `{ expiresAt?, maxUses? }`. Returns `{ invite, url }`. |
| `/api/campaigns/[id]/invites` | GET | host | List active invites (revoked_at IS NULL, expires_at OK, uses_count < max_uses). |
| `/api/campaigns/[id]/invites/[inviteId]` | DELETE | host | Set `revoked_at = now()`. Returns 204. |
| `/api/r/[token]` | GET | none | Resolve token. Returns `{ campaignId, campaignName, hostName }` or `410 Gone` with reason. |
| `/api/campaigns/[id]/join` | POST | signed-in | Body: `{ token, characterTemplateId }`. Validates token + template ownership + party uniqueness. Forks template, increments `uses_count`, returns `{ sessionId }`. |
| `/api/sessions/[id]/stream` | GET | party member or host | SSE stream. Initial snapshot + event forwarding from `LISTEN session_<id>`. Dedicated pg connection per subscriber. |

### 4.2 Modified routes

| Route | Change |
|---|---|
| `POST /api/sessions/[id]/turn` | Permission check: `req.userId == user_id of character pointed at by sessions.current_player_character_id`. 403 `not-your-turn` if mismatch. Becomes fire-and-forget from client's perspective; chunks broadcast via NOTIFY. Returns 202 Accepted on completion. |
| `GET /api/sessions/[id]` | Response shape extended with `{ party: Character[] }` — all instance characters with `campaign_id = sessions.campaign_id`, not deleted. |

### 4.3 Master tool `set_current_player`

```typescript
{
  name: 'set_current_player',
  description: 'Sets which character takes the next turn. Call at the end of each narrative beat. The character must be in the party.',
  input_schema: {
    type: 'object',
    required: ['characterId'],
    properties: {
      characterId: { type: 'string', description: 'uuid of the next character to act' },
    },
  },
}
```

Handler:

```typescript
async function handleSetCurrentPlayer({ sessionId, characterId, tx }) {
  const [valid] = await tx
    .select({ id: characters.id })
    .from(characters)
    .innerJoin(sessions, eq(sessions.campaignId, characters.campaignId))
    .where(and(
      eq(sessions.id, sessionId),
      eq(characters.id, characterId),
      isNull(characters.deletedAt),
      isNotNull(characters.templateId),
    ))
    .limit(1);
  if (!valid) return { error: 'character-not-in-party' };

  await tx
    .update(sessions)
    .set({ currentPlayerCharacterId: characterId, turnsSinceMasterAdvance: 0 })
    .where(eq(sessions.id, sessionId));

  await notifySession(sessionId, { type: 'turn-change', characterId });
  return { ok: true };
}
```

### 4.4 Server-side post-loop hook (fallback round-robin)

Runs after the master loop completes inside `POST /turn`:

```typescript
const [{ tsma, cpcId }] = await tx
  .select({ tsma: sessions.turnsSinceMasterAdvance, cpcId: sessions.currentPlayerCharacterId })
  .from(sessions)
  .where(eq(sessions.id, sessionId))
  .limit(1);

if (tsma === 0) {
  // Master called set_current_player during the loop. No advance needed.
} else {
  const next = tsma + 1;
  if (next >= 3) {
    // Round-robin advance
    const party = await tx
      .select()
      .from(characters)
      .where(and(
        eq(characters.campaignId, campaignId),
        isNull(characters.deletedAt),
        isNotNull(characters.templateId),
      ))
      .orderBy(characters.createdAt);
    const idx = party.findIndex((c) => c.id === cpcId);
    const nextChar = party[(idx + 1) % party.length];
    await tx
      .update(sessions)
      .set({ currentPlayerCharacterId: nextChar.id, turnsSinceMasterAdvance: 0 })
      .where(eq(sessions.id, sessionId));
    await notifySession(sessionId, { type: 'turn-change', characterId: nextChar.id });
  } else {
    await tx
      .update(sessions)
      .set({ turnsSinceMasterAdvance: next })
      .where(eq(sessions.id, sessionId));
  }
}

await tx
  .update(sessions)
  .set({ turnSeq: sql`turn_seq + 1` })
  .where(eq(sessions.id, sessionId));
```

### 4.5 Permission check on `POST /turn`

```typescript
const [row] = await db
  .select({
    cpcId: sessions.currentPlayerCharacterId,
    cpcOwner: characters.userId,
  })
  .from(sessions)
  .innerJoin(characters, eq(characters.id, sessions.currentPlayerCharacterId))
  .where(eq(sessions.id, sessionId))
  .limit(1);
if (!row) return NextResponse.json({ error: 'session-not-found' }, { status: 404 });
if (row.cpcOwner !== auth.userId) {
  return NextResponse.json({ error: 'not-your-turn', currentCharacterId: row.cpcId }, { status: 403 });
}
```

## 5. Master loop changes

### 5.1 Snapshot builder refactor

```typescript
// Before
buildSnapshot(sessionId, userId) → { session, campaign, state, character }

// After
buildSnapshot(sessionId, viewerUserId) → {
  session,
  campaign,
  state,
  party: Character[],                // all characters with campaign_id = X, instances only
  currentPlayerCharacterId: string | null,
  viewerCharacterId: string | null,  // party.find(c => c.userId === viewerUserId)?.id
}
```

The same builder serves both the master prompt (party array, all characters, active marked) and the client UI (viewer identifies own character via `viewerCharacterId`).

### 5.2 System prompt addition

```
PARTY MODE: This campaign has a party of {N} characters: {comma-separated list of character names with race/class}. Address players by their character name (e.g., "Tharion, you see..."). Never use "you" to refer to multiple players ambiguously. The character currently acting is {currentCharacterName}.

AT END OF EACH NARRATIVE BEAT, call the tool set_current_player with the characterId of the next player to act. Pick based on narrative tension, party initiative, or round-robin as feels natural. If you do not call set_current_player for 3 consecutive turns, the system will auto-advance round-robin to prevent deadlock.
```

### 5.3 Token cost impact

With 4 characters in the party and ~500-1500 tokens per character snapshot, the dynamic delta of the master prompt grows by ~2-6k tokens per turn. The cached static prefix is unchanged. Per-turn cost increase on Claude Sonnet 4.6: ~$0.01-0.03 with 4 PCs. Acceptable for the value delivered.

## 6. Real-time layer (SSE + Postgres LISTEN/NOTIFY)

### 6.1 Notify helper

```typescript
// src/sessions/notify.ts
export async function notifySession(
  sessionId: string,
  payload: { type: 'message-chunk' | 'message' | 'state' | 'turn-change' | 'dice'; [k: string]: any },
) {
  const json = JSON.stringify(payload);
  if (json.length > 7900) {
    console.warn('notifySession payload too large, dropping content', { sessionId, type: payload.type });
    return;
  }
  await db.execute(sql`SELECT pg_notify(${`session_${sessionId}`}, ${json})`);
}
```

Called by:
- `applicator.ts` — after state mutations (HP, conditions, slots) → `{ type: 'state' }`
- `applicator.ts` dice rolls → `{ type: 'dice', logId }`
- Master streaming layer — per chunk → `{ type: 'message-chunk', text, messageId }`
- Master persistence — after final message INSERT → `{ type: 'message', messageId }`
- `set_current_player` handler → `{ type: 'turn-change', characterId }`

### 6.2 SSE endpoint

```typescript
// src/app/api/sessions/[id]/stream/route.ts
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return new Response('unauthorized', { status: 401 });
  const { id: sessionId } = await ctx.params;

  const access = await checkPartyAccess(userId, sessionId);
  if (!access) return new Response('forbidden', { status: 403 });

  const client = await pool.connect();

  const stream = new ReadableStream({
    async start(controller) {
      const snapshot = await buildSnapshot(sessionId, userId);
      controller.enqueue(`data: ${JSON.stringify({ type: 'snapshot', snapshot })}\n\n`);

      await client.query(`LISTEN "session_${sessionId}"`);
      client.on('notification', (msg) => {
        controller.enqueue(`data: ${msg.payload}\n\n`);
      });

      const ka = setInterval(() => controller.enqueue(`: keep-alive\n\n`), 25_000);

      req.signal.addEventListener('abort', async () => {
        clearInterval(ka);
        await client.query(`UNLISTEN "session_${sessionId}"`).catch(() => {});
        client.release();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' },
  });
}
```

### 6.3 Unified client hook

```typescript
// src/sessions/use-session-stream.ts (replaces use-session-state + use-turn-stream)
function useSessionStream(sessionId: string) {
  const [snapshot, setSnapshot] = useState(null);
  const [streamingMessage, setStreamingMessage] = useState<{ text: string; messageId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/sessions/${sessionId}/stream`);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      switch (ev.type) {
        case 'snapshot':
          setSnapshot(ev.snapshot);
          setError(null);
          break;
        case 'message-chunk':
          setStreamingMessage((prev) => ({ ...prev, text: (prev?.text ?? '') + ev.text, messageId: ev.messageId }));
          break;
        case 'message':
          setStreamingMessage(null);
          refetchSnapshot();
          break;
        case 'state':
        case 'dice':
          refetchSnapshot();
          break;
        case 'turn-change':
          setSnapshot((s) => (s ? { ...s, currentPlayerCharacterId: ev.characterId } : s));
          break;
      }
    };
    es.onerror = () => setError('connection_lost');
    return () => es.close();
  }, [sessionId]);

  return { snapshot, streamingMessage, error };
}
```

### 6.4 Connection management

- **One pg connection per active SSE stream**. With 4 players × max 2 tabs = 8 connections. Default pool size 10-15 is sufficient.
- **`UNLISTEN` + `client.release()` on abort** prevents pool exhaustion.
- **Heartbeat every 25s** keeps intermediaries from closing the connection.
- **Vercel Fluid Compute** supports streaming natively; no special infra config needed.

### 6.5 POST /turn becomes fire-and-forget

Current behavior: `POST /turn` returns SSE response with master chunks. The current player's client watches this stream.

New behavior: `POST /turn` runs the master loop server-side, NOTIFY-ing each chunk via `notifySession({ type: 'message-chunk', ... })`. Returns `202 Accepted` (or `5xx` on error) when the loop completes. The current player's client sees the master response arrive via their already-open `/stream` connection — the same one all other players use.

This means `src/sessions/use-turn-stream.ts` is removed; `use-session-stream.ts` is the single hook.

## 7. UI

### 7.1 New + modified pages

```
+ /r/[token]                    server: resolve token, redirect to /campaigns/[id]/join?token=...
+ /campaigns/[id]/join          server: fetch templates, redirect to /characters/new?returnTo=...
                                if user has none. Client: pick template + Join button.
~ /campaigns/[id]               host: invite section + party list (multiple characters)
                                guest: read-only view (no invite section, no rename/delete)
~ /sessions/[id]                game screen: party strip + composer gating + author-aware bubbles
~ /characters/new               supports ?returnTo= query param; redirects on save
= /hub                          unchanged (campaign cards already work for multi-character)
```

### 7.2 `/r/[token]` resolve page

Server component, ~30 lines:

```tsx
export default async function ResolveInvite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await fetch(`${baseUrl}/api/r/${token}`, { cache: 'no-store' });
  if (!res.ok) return <ExpiredInviteCard />;
  const { campaignId } = await res.json();
  redirect(`/campaigns/${campaignId}/join?token=${token}`);
}
```

`<ExpiredInviteCard />`: "This invite link is no longer valid (expired, revoked, or fully used). Ask the host for a new link."

### 7.3 `/campaigns/[id]/join` join page

Server component fetches user's character templates; redirects to `/characters/new?returnTo=...` if none. Otherwise renders a client component for character selection + join submit.

```tsx
// page.tsx (server)
const { userId } = await auth();
if (!userId) redirect(`/sign-in?redirect_url=...`);
const templates = await listTemplates(userId);
if (templates.length === 0) {
  redirect(`/characters/new?returnTo=${encodeURIComponent(`/campaigns/${id}/join?token=${token}`)}`);
}
return <JoinClient campaignId={id} token={token} templates={templates} campaign={campaignInfo} />;
```

`<JoinClient>` renders a grid of template cards (same style as wizard step 1) + "Join {campaignName} as {selectedTemplate}" button. Posts `{ token, characterTemplateId }` to `/api/campaigns/[id]/join`. On 201 redirects to `/sessions/[sessionId]`. On 409 (already in party) redirects to existing session. On 410 (invalid token) shows `<ExpiredInviteCard />`.

### 7.4 Character wizard `returnTo` support

`src/app/(authed)/characters/new/wizard-client.tsx` reads `?returnTo=` query param. On final save success, redirects to that URL if present, otherwise to `/hub`.

### 7.5 Campaign detail page

**Host view** (`campaign.user_id === viewerUserId`):

```
[Header: name (editable) · status/style/lang chips · "Continue →" · ⋯ menu]

┌─ Invite link ────────────────────────────────────────────┐
│ https://app/r/k7Q3-fjk              [Copy] [⋯ menu]      │
│ Active · expires in 7 days · 1 of 5 uses                 │
│ ⋯ menu: Regenerate · Revoke · Set no expiry · Single use │
└──────────────────────────────────────────────────────────┘
(if no active invite: "Generate invite link" button)

[Party (N) section]
Grid of character mini-cards
   ▸ You: Tharion (Half-Elf Fighter L3)
   ▸ Lyra (Tiefling Cleric L5)
   ▸ Brendor (Halfling Rogue L2)

[Premise card]
[Last played · Created meta]
```

**Guest view**: same layout minus the Invite link section, minus the `⋯` menu items (rename/delete are host-only).

### 7.6 Game screen `/sessions/[id]`

```
┌─────────────────────┬───────────────────────────────┬─────────────────────────┐
│ Your character      │ Chat log                      │ Mechanics               │
│ (viewer's own)      │                               │                         │
│                     │ ┌─ Party strip ─────────────┐ │ Combat tracker          │
│ Tharion             │ │ ● Tharion (acting)        │ │ Dice log                │
│ Half-Elf Fighter L3 │ │   Lyra · Brendor          │ │ Scene image             │
│ HP 21/27 · AC 16    │ └───────────────────────────┘ │                         │
│ Conditions · Slots  │                               │                         │
│ Inventory           │ The Master: "..." [streaming] │                         │
│                     │ Tharion: "I draw my sword."   │                         │
│                     │ The Master: "Lyra, you see..." │                        │
│                     │                               │                         │
│                     │ [textarea] [Send]             │                         │
│                     │  (disabled if not your turn:  │                         │
│                     │   "Waiting for Lyra…")        │                         │
└─────────────────────┴───────────────────────────────┴─────────────────────────┘
```

Key changes:
- **Left pane**: viewer's own character. `party.find(c => c.userId === viewerUserId)`. If host without a party character (edge case): "You are spectating" placeholder.
- **Party strip** (new component, top of chat log): row of pills, one per party member. "Currently acting" indicator (dot + accent border) on the active character. Click → tooltip with HP/AC/conditions.
- **Chat bubbles**: each message rendered with author prefix. `author_character_id == null` → "The Master:" (or "System:" for system role). Otherwise → `{character.name}:`.
- **Composer**: textarea + quick-action buttons (Skill check, Attack, Dodge, Short rest, Look up rule) disabled when `viewerCharacterId !== currentPlayerCharacterId`. Hint: "Waiting for {currentCharacterName}…"
- **Streaming message**: when `message-chunk` arrives, render a pending bubble below the chat list with accumulating text. When `message` arrives, the bubble is replaced by the persisted message from the next snapshot refetch.

### 7.7 Host symmetry decision

Campaign creation (existing) still forks the host's character automatically. This preserves the solo workflow with zero new clicks: create campaign → immediately land in game screen as the only party member. Guests use the invite/join flow to add themselves to the party.

If a host wants to spectate without playing, they can manually remove their character from the party post-creation (slice B feature). For minimum slice, hosts always have a character in the party.

## 8. Migration

Single Drizzle migration (auto-generated suffix; expected `0029_*.sql`):

### 8.1 DDL (additive)

```sql
-- 1. campaign_invites table
CREATE TABLE campaign_invites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  token               text NOT NULL UNIQUE,
  created_by_user_id  text NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  revoked_at          timestamptz,
  max_uses            integer,
  uses_count          integer NOT NULL DEFAULT 0
);
CREATE INDEX campaign_invites_token_idx    ON campaign_invites(token);
CREATE INDEX campaign_invites_campaign_idx ON campaign_invites(campaign_id);

-- 2. sessions columns
ALTER TABLE sessions ADD COLUMN current_player_character_id uuid REFERENCES characters(id);
ALTER TABLE sessions ADD COLUMN turn_seq                    integer NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN turns_since_master_advance  integer NOT NULL DEFAULT 0;

-- 3. session_messages column
ALTER TABLE session_messages ADD COLUMN author_character_id uuid REFERENCES characters(id) ON DELETE SET NULL;
```

### 8.2 Backfill (transactional)

```sql
BEGIN;

-- Existing sessions: current_player = the (only) character
UPDATE sessions
SET current_player_character_id = character_id
WHERE current_player_character_id IS NULL;

-- Existing player messages: author = session's character at the time
UPDATE session_messages sm
SET author_character_id = s.character_id
FROM sessions s
WHERE sm.session_id = s.id
  AND sm.role = 'player'
  AND sm.author_character_id IS NULL;

COMMIT;
```

### 8.3 PR 2 follow-up (≥1 week after stable production)

```sql
ALTER TABLE sessions ALTER COLUMN current_player_character_id SET NOT NULL;
```

### 8.4 Test fixture updates

Tests that insert `session_messages` rows directly with `role='player'` must include `author_character_id`. Estimated affected files: ~5-10 (similar pattern to Task 18b in campaign management). Tests inserting via the API path are unaffected (the API handler sets it automatically).

## 9. Errors and edge cases

| Case | Behavior |
|---|---|
| `POST /invites` from a non-host user | 403 Forbidden |
| `POST /invites` with `expiresAt` in the past | 422 Unprocessable |
| `GET /r/[token]` for revoked/expired/maxed invite | 410 Gone with reason |
| `POST /join` with token not matching the campaign in URL | 410 Gone |
| `POST /join` with user already in the campaign's party | 409 Conflict, response includes existing sessionId for redirect |
| `POST /join` with characterTemplateId not owned by user | 403 Forbidden |
| `POST /join` with characterTemplateId that is an instance | 422 `not-a-template` (reuses existing forge logic) |
| `POST /turn` from a non-current-player user | 403 `not-your-turn` with response `{ currentCharacterId }` for UI feedback |
| Master never calls `set_current_player` | After 3 consecutive turns, server advances round-robin |
| Master calls `set_current_player` with characterId not in party | Tool returns `{ error: 'character-not-in-party' }`; master adapts narrative; counter not reset (still ticks toward fallback) |
| SSE client disconnects mid-stream | pg client released via `UNLISTEN` + `client.release()`. New connect → new dedicated client |
| Two browser tabs of same user | Both subscribe, both receive events. Idempotent — UI just re-renders |
| NOTIFY payload >8KB | Defensive truncation + warning log. Master chunks are <500 bytes in practice; not expected to hit |
| pg pool exhaustion | Monitor; default pool 10-15 sufficient for 4 players × 2 tabs. Bump pool size or move to LISTEN multiplexing in a follow-up |
| Host deletes campaign while session in flight | Soft-delete cascades; SSE streams receive `state` event reflecting deletion; UI navigates back to /hub |

## 10. Testing

### 10.1 Unit (no DB)

- Token generator: `generateInviteToken()` produces 12-char URL-safe, uniqueness via DB constraint
- Invite validity check: `isInviteValid()` handles all combinations of (revoked, expired, maxed)
- Round-robin helper: `nextInParty(currentId, party)` correctly wraps around

### 10.2 DB integration

- `campaign_invites` cascade on `DELETE FROM campaigns` removes the invite
- Token uniqueness constraint rejects collisions
- Backfill produces consistent state: no orphan messages, all player messages have author

### 10.3 API integration (`tests/api/multiplayer.test.ts`)

- POST /invites: host 201; guest 403; invalid `expiresAt` 422
- GET /r/[token]: valid 200; revoked 410; expired 410; maxed 410; unknown 410
- POST /join: happy path 201; already in party 409; instance id 422; foreign template 403; wrong token 410
- POST /turn: current player 200/202; non-current 403 `not-your-turn`
- DELETE /invites/[id]: host 204; guest 403

### 10.4 Master loop (`tests/ai/master/multiplayer-loop.test.ts`)

- `set_current_player` tool roundtrip: handler updates DB, resets counter, emits NOTIFY (mock)
- Tool validation: characterId not in party → `{ error }` returned; counter not reset
- Fallback round-robin: 3 turns without tool → server advances in `created_at` order; wraps around
- Party snapshot in system prompt: all characters present, active marked, viewer's char identifiable
- Per-turn cost is bounded by N characters (regression check: snapshot size linear in N)

### 10.5 SSE stream (`tests/api/sessions-stream.test.ts`)

- Snapshot delivery on connect (initial event)
- LISTEN event forwarded to SSE response
- Auth gate: non-party member → 403
- Cleanup on abort: pg client released
- Heartbeat lines emitted

### 10.6 E2E (Playwright, `tests/e2e/multiplayer.spec.ts`)

Skip flag `!HAS_CLERK_TESTING` for tests requiring auth.

Multi-browser-context flow:
1. Host browser: create campaign → /campaigns/[id] → "Generate invite link" → copy URL
2. Guest browser: visit URL → /sign-in (test token) → /campaigns/[id]/join → pick template → "Join"
3. Both browsers open /sessions/[id]
4. Both see same chat log; host's composer enabled, guest's disabled with "Waiting for {host}…"
5. Host sends message → both see chunk-streaming → master responds → composer switches per `set_current_player`
6. Host revokes invite via campaign detail → guest already in party can still play

### 10.7 Coverage target

- New module `src/multiplayer/` (or wherever invite/notify/party helpers land) ≥ 85% lines
- No regression on existing test suite (current baseline: 1757 passing, 3 pre-existing failures)

## 11. Acceptance criteria

The minimum slice is "done" when all hold:

- [ ] Two or more authenticated users can play in the same campaign via invite link
- [ ] All party members see the same chat log in real-time via SSE
- [ ] Composer is enabled only for the user whose character matches `current_player_character_id`
- [ ] Master calling `set_current_player` updates all clients' turn indicator within <500ms
- [ ] If master does not call `set_current_player` for 3 consecutive turns, server advances round-robin
- [ ] Host can revoke an invite; party members already joined continue to play
- [ ] Solo workflow (1-character campaign) continues to work without changes
- [ ] Coverage on new multiplayer module ≥ 85%
- [ ] All 4 §7.8 invariant queries from campaign management continue to return 0
- [ ] No regression on existing 1757-passing test baseline
- [ ] All E2E multiplayer cases pass with `HAS_CLERK_TESTING=1`

## 12. Open questions deferred to implementation

- **Player offline timeout**: should there be a hard timeout (e.g., 5 minutes idle on current player → auto-pass)? Defer; manual host intervention via DB or rely on the 3-turn fallback if the master picks differently.
- **Leave campaign UX**: should guests have a "Leave campaign" button on detail page? Defer to slice B; in minimum slice, guests can close the tab and the host can remove them via DB.
- **Host re-assignment**: if the host's Clerk account is deleted, the campaign cascades. Defer multi-host model to a future slice.
- **Token expiration default**: should `expiresAt` default to 7 days or unlimited? Recommend 7 days as a safe default with a "no expiry" override in the UI. Implementer's call.
- **POST /turn streaming back to current player**: technically the chunks arrive via the unified SSE. Should `POST /turn` still emit an SSE response for the active client as a fallback if their stream is disconnected? Defer; the unified stream is robust enough.
- **Rate limit on `/api/r/[token]`**: 10 req/min per IP recommended. Implementer's call on which middleware to use.

## 13. Related work

- Sub-project #5 (Campaign management): [2026-05-12-campaign-management-design.md](2026-05-12-campaign-management-design.md). Provides the schema and refactor foundations.
- Design handoff: `design/prototype/app/screens-lobby.jsx` shows the lobby UX intended for slice B. Minimum slice (this doc) skips the lobby entirely — join is direct.
- Master World Lore / Master Handbook system prompts: extended with the PARTY MODE block (§5.2).
