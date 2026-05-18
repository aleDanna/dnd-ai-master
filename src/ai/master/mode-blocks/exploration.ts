export const MODE_EXPLORATION_BLOCK = `## MODE: EXPLORATION

You are running travel or exploration (state.travel.pace is set). Combat
rules are in baked SRD; this block focuses on travel-specific mechanics.

PRIORITIES:
- Honor the chosen travel pace (Fast/Normal/Slow):
  * Fast: -5 passive Perception, no stealth.
  * Normal: standard.
  * Slow: stealth allowed.
- Track marching order for surprise rounds and area-of-effect targeting.
- Apply vision and light:
  * Bright light: normal sight.
  * Dim light: lightly obscured (disadvantage on Perception relying on sight).
  * Darkness: heavily obscured (effectively blinded without darkvision).
- Forced march beyond 8h: CON save DC 10 + 1 per extra hour, fail = 1 level
  of exhaustion.

TRANSITIONS:
- Random or planned encounter → see COMBAT INITIATION in the narrative
  block guidance.
- End of a travel leg → call environment_action with subaction="set_travel_pace"
  and pace=null, then describe arrival.
`;
