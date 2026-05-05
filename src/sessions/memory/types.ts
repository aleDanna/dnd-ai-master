import type {
  CodexKind,
  CodexNpcData,
  CodexLocationData,
  CodexQuestData,
  CodexFactionData,
  CodexLoreFactData,
  CodexNamedItemData,
  CodexRelationshipData,
} from '@/db/schema/codex-entities';

/** A single upsert instruction for a codex entity. The slug is the primary
 * dedup key together with (sessionId, kind). When the entity already exists,
 * `data` and `name` are overwritten; when it does not, a new row is inserted. */
export interface CodexUpsert {
  kind: CodexKind;
  slug: string;
  name: string;
  data:
    | CodexNpcData
    | CodexLocationData
    | CodexQuestData
    | CodexFactionData
    | CodexLoreFactData
    | CodexNamedItemData
    | CodexRelationshipData;
}

/** Output of the extractor. `chapter` is present only in Full mode. */
export interface MemoryPatch {
  upserts: CodexUpsert[];
  chapter?: {
    chapterIndex: number;
    firstMsgId: string;
    lastMsgId: string;
    messageCount: number;
    summary: string;
  };
  /** ID of the last message read by the extractor in this run. Used to update
   * lastSeenMsgId on every upserted entity. */
  lastSeenMsgId: string;
}

/** Light vs Full mode. Full produces a chapter; Light only updates the codex. */
export type ExtractorMode = 'light' | 'full';
