import { describe, it, expect } from 'vitest';
import { AnnotationBudget, PersistentLabels, type LabelCandidate } from '../annotations/PersistentLabels.js';
const candidate = (id: string, priority = 50, eligibility = 2): LabelCandidate => ({ id, priority, eligibility, box:{x0:10,y0:10,x1:100,y1:30} });
function settle(layout: PersistentLabels, items: LabelCandidate[], at = 0) {
  for (let i=0;i<=4;i++) layout.update(items, [], at+i*100);
}
describe('persistent annotation arbitration', () => {
  it('retains identity and priority through small movement and 25 percent LOD hysteresis', () => {
    const l = new PersistentLabels();
    settle(l,[candidate('a'),candidate('b',49)]);
    const a=l.states.get('a');
    for(let i=0;i<100;i++) {
      l.update([{...candidate('a',50,i%2 ? .99:1.01),box:{x0:10+i*.01,y0:10,x1:100+i*.01,y1:30}},candidate('b',53)],[],500+i*16);
      expect(l.states.get('a')).toBe(a);
      expect(a?.accepted).toBe(true);
    }
    expect(l.enters).toBe(1);expect(l.exits).toBe(0);
    l.update([candidate('a',50,.74)],[],2200);
    expect(a?.accepted).toBe(false);expect(a?.opacity).toBeGreaterThan(0);
  });
  it('selected and external annotation obstacles win; physical omission evicts immediately', () => {
    const l=new PersistentLabels();settle(l,[candidate('a')]);
    const selected={...candidate('b',1),selected:true};
    settle(l,[candidate('a'),selected],500);
    expect(l.states.get('b')?.opacity).toBe(1);expect(l.states.has('a')).toBe(false);
    l.update([selected],[selected.box],1000);expect(l.states.size).toBe(0);
    settle(l,[candidate('a')],1100);l.update([],[],1600);expect(l.states.size).toBe(0);
  });
  it('bounds placements and is deterministic under candidate input reordering', () => {
    const a=new PersistentLabels(3),b=new PersistentLabels(3);
    const items=Array.from({length:10},(_,i)=>({...candidate(String(i)),box:{x0:i*110,y0:0,x1:i*110+100,y1:20}}));
    settle(a,items);settle(b,[...items].reverse());
    expect([...a.states.keys()]).toEqual([...b.states.keys()]);expect(a.states.size).toBe(3);
  });
  it('fades ordinary collision changes while selection and safety obstacles preempt immediately', () => {
    const l=new PersistentLabels();settle(l,[candidate('old')]);
    l.update([candidate('old'),candidate('higher',70)],[],500);
    expect(l.states.get('old')?.accepted).toBe(false);
    expect(l.states.get('old')?.opacity).toBeGreaterThan(0);
    expect(l.states.get('higher')?.opacity).toBeGreaterThan(0);
  });
  it('reserves a bounded render slot for selection ahead of old fading states', () => {
    const l=new PersistentLabels(1);settle(l,[candidate('old')]);
    const selected={...candidate('new'),selected:true,box:{x0:200,y0:0,x1:300,y1:20}};
    const drawn=l.update([candidate('old',50,0),selected],[],500);
    expect(drawn.map(s=>s.id)).toEqual(['new']);
  });
  it('budget skips work without emitting a false visibility result and always advances one query', () => {
    let now=0;const budget=new AnnotationBudget(2,()=>now);
    expect(budget.run(()=>{now=3;return false;})).toEqual({value:false});
    expect(budget.run(()=>true)).toBeUndefined();
    const next=new AnnotationBudget(0,()=>now);expect(next.run(()=>false)).toEqual({value:false});
  });
});
