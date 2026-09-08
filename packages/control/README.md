# @cosmolabe/control

`ViewerControl` — the port a Cosmolabe viewer exposes for control and
observation — plus the no-eval `verb arg…` script language written against it.

Zero dependencies, no DOM. This package names no renderer, no framework and no
global; the viewer implements the port, and everything else programs against it.

```
npm i @cosmolabe/control
```

## One vocabulary, three faces

| Face | For | Gets |
|---|---|---|
| the typed `ViewerControl` interface | embed / host control | the full surface, structured arguments, reads and events — loops come from the host's own JavaScript |
| the `verb arg…` text language | scene setup, saved programs, visual-regression goldens | no eval, checked in, safe to hand a stranger |
| the `VERBS` table | command palette, keymap | one vocabulary, derived rather than restated |

The interface is the contract. `window.cosmo` in the viewer app is one binding
of it — nothing here requires a global, and no method reaches for one.

## The port

```ts
import type { ViewerControl } from '@cosmolabe/control';

// Writes return false for "no such name" — the host does not throw, because it
// does not know the line number. The interpreter, which does, turns that into a
// located error.
await cosmo.gotoObject('Titan');
cosmo.setFrame('body-fixed', 'Titan');
cosmo.showTrajectory('Cassini', true);

// It reads, too. A host that can push but never observe cannot build UI.
cosmo.getSelected();
cosmo.isPlaying();
const off = cosmo.on('select', ({ name }) => console.log('selected', name));
```

Optional methods (`wait`, `screenshot`, `record`) **are** the capability
declaration: a host that does not implement one gets a located error at the
statement that needed it, never a silent no-op.

`cosmo.snapshot()` returns the script that reproduces the current view. It is a
serialization surface, not a state model — it derives its text from the read
side and holds nothing of its own.

## The language

```
setPlaying off
setTime 2004-10-26T15:30:00Z
gotoObject Titan
setFrame body-fixed Titan
showTrajectory Cassini on
setLayer labels off
displayNote "T-A flyby - Titan body-fixed"
```

```ts
import { parse, execute } from '@cosmolabe/control';

const program = parse(source);           // throws ScriptSyntaxError with EVERY problem
const report = await execute(program, cosmo); // throws ScriptRuntimeError at the FIRST
```

One statement per line, so a reported line number is exact by construction.
Quoted names, `[x, y, z]` vectors, `#` comments, `on|off|true|false`. No
variables, no expressions, no control flow, no `run <program>`, no `eval` — a
host that wants a loop writes JavaScript against the interface, which is the
same division Cosmographia makes with Python.

`runTo <seconds>` advances *scene* time by an exact amount and is deterministic.
`wait <seconds>` is a *wall-clock* settle for streamed data and is not; pass
`{ forbid: ['wait'] }` to `parse` where a frame has to be reproducible.

Full reference, including the `Cosmo()` mapping table:
[`docs/scripting.md`](../../docs/scripting.md).

## License

Apache-2.0
