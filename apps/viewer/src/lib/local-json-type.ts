/** Read the root `type` without materializing a possibly huge geographic payload.
 * Only keys/type strings are retained (bounded scratch space), with JSON's last-key-wins semantics.
 * This is classification, not validation: accepted catalog text still goes through JSON.parse.
 */
export async function readLocalJsonType(file: File, signal?: AbortSignal): Promise<string | undefined> {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let depth = 0, quoted = false, escaped = false, rootObject = false;
  let expectingKey = true, key: string | undefined, type: string | undefined;
  let role: 'key' | 'type' | 'other' = 'other', scratch = '', truncated = false;
  const scan = (text: string) => {
    for (const c of text) {
      if (quoted) {
        if (!escaped && c === '"') {
          quoted = false;
          let value: string | undefined;
          if (role !== 'other' && !truncated) {
            try { value = JSON.parse(`"${scratch}"`) as string; } catch { /* JSON.parse later diagnoses invalid syntax. */ }
          }
          if (role === 'key') { key = value; expectingKey = false; }
          if (role === 'type') type = value;
        } else {
          if (role !== 'other') {
            if (scratch.length < 64) scratch += c;
            else truncated = true;
          }
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
        }
      } else if (c === '"') {
        quoted = true;
        role = depth === 1 && rootObject ? (expectingKey ? 'key' : key === 'type' ? 'type' : 'other') : 'other';
        scratch = ''; truncated = false;
      } else if (c === '{' || c === '[') {
        if (depth === 0) rootObject = c === '{';
        depth++;
      } else if (c === '}' || c === ']') depth--;
      else if (depth === 1 && rootObject && c === ',') { expectingKey = true; key = undefined; }
      else if (depth === 1 && rootObject && c === ':' && key === 'type') type = undefined;
    }
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      scan(decoder.decode(value, { stream: true }));
    }
    scan(decoder.decode());
    return type;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
