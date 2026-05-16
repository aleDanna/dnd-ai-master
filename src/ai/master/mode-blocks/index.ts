import { MODE_COMBAT_BLOCK } from './combat';
import { MODE_NARRATIVE_BLOCK } from './narrative';
import { MODE_EXPLORATION_BLOCK } from './exploration';
import { SPELLCASTING_OVERLAY_BLOCK } from './spellcasting-overlay';
import type { MasterMode } from '../mode';

export {
  MODE_COMBAT_BLOCK,
  MODE_NARRATIVE_BLOCK,
  MODE_EXPLORATION_BLOCK,
  SPELLCASTING_OVERLAY_BLOCK,
};

export const MODE_BLOCKS: Record<MasterMode, string> = {
  combat: MODE_COMBAT_BLOCK,
  narrative: MODE_NARRATIVE_BLOCK,
  exploration: MODE_EXPLORATION_BLOCK,
};
