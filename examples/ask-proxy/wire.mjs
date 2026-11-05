/**
 * Cosmolabe's model wire format (`AGENT_WIRE_VERSION` in `@cosmolabe/control`),
 * as the proxy checks it. Both provider translations start from `checkWire`,
 * so a client can send no more than the viewer's own request shape, whichever
 * provider answers.
 */
export const WIRE_VERSION = 1;
export const MAX_MESSAGES = 200;
export const MAX_TOOLS = 64;
export const MAX_SYSTEM_CHARS = 20_000;

/** The request's shape checked, as `{ system, messages, tools }`, or `{ error }`. Blocks are the provider's to check. */
export function checkWire(wire) {
  const fail = (error) => ({ error });
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return fail('body must be a JSON object');
  if (wire.version !== WIRE_VERSION) return fail(`wire version must be ${WIRE_VERSION}`);
  if (typeof wire.system !== 'string' || wire.system.length > MAX_SYSTEM_CHARS) return fail(`system must be a string of at most ${MAX_SYSTEM_CHARS} characters`);
  if (!Array.isArray(wire.messages) || wire.messages.length === 0 || wire.messages.length > MAX_MESSAGES) return fail(`messages must be 1 to ${MAX_MESSAGES} entries`);
  if (!Array.isArray(wire.tools) || wire.tools.length > MAX_TOOLS) return fail(`tools must be an array of at most ${MAX_TOOLS}`);
  const tools = [];
  for (const t of wire.tools) {
    if (!t || typeof t.name !== 'string' || typeof t.description !== 'string' || !t.inputSchema || typeof t.inputSchema !== 'object') return fail('each tool needs name, description and inputSchema');
    tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
  }
  for (const m of wire.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || !Array.isArray(m.content)) return fail('each message needs a role and content');
  }
  return { system: wire.system, messages: wire.messages, tools };
}
