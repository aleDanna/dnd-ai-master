/**
 * Out-of-character (OOC) message convention.
 *
 * Players prefix a chat message with "!" to address the master directly
 * — to ask about rules, character options, mechanics, or anything
 * meta-game — without that message being interpreted as an in-character
 * action. The master is told (via the system prompt) to answer the
 * question without advancing the story or calling state-mutation tools.
 *
 * The prefix is preserved verbatim in `session_messages.content` so the
 * convention is a runtime read, not a schema change. Both server-side
 * (turn route, history rebuild) and client-side (chat rendering)
 * detect it via the helpers below.
 */

export const OOC_PREFIX = '!';

/** True if the message is OOC (starts with the prefix, ignoring leading whitespace). */
export function isOocMessage(text: string): boolean {
  return text.trimStart().startsWith(OOC_PREFIX);
}

/** Strip the leading "!" + any whitespace around it. Used by the chat UI to display the question without the marker. */
export function stripOocPrefix(text: string): string {
  return text.replace(/^\s*!\s*/, '');
}
