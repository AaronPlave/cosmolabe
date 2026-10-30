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
  it('selected and external annotation obstacles win; physical invalidation evicts immediately', () => {
    const l=new PersistentLabels();settle(l,[candidate('a')]);
    const selected={...candidate('b',1),selected:true};
    settle(l,[candidate('a'),selected],500);
    expect(l.states.get('b')?.opacity).toBe(1);expect(l.states.has('a')).toBe(false);
    l.update([selected],[selected.box],1000);expect(l.states.size).toBe(0);
    settle(l,[candidate('a')],1100);l.update([],[],1600,new Set(['a']));expect(l.states.size).toBe(0);
  });
  it('bounds placements and is deterministic under candidate input reordering', () => {
    const a=new PersistentLabels(3),b=new PersistentLabels(3);
    const items=Array.from({length:10},(_,i)=>({...candidate(String(i)),box:{x0:i*110,y0:0,x1:i*110+100,y1:20}}));
    settle(a,items);settle(b,[...items].reverse());
    expect([...a.states.keys()]).toEqual([...b.states.keys()]);expect(a.states.size).toBe(3);
  });
  it('fades ordinary collision changes while selection and safety obstacles preempt immediately', () => {
    const l=new PersistentLabels();settle(l,[candidate('old')]);
    l.update([candidate('old'),candidate('higher',80)],[],500);
    expect(l.states.get('old')?.accepted).toBe(false);
    expect(l.states.get('old')?.opacity).toBeGreaterThan(0);
    expect(l.states.get('higher')?.opacity).toBe(0);
    for (let now=600; now<=1000; now+=50) {
      const drawn=l.update([candidate('old'),candidate('higher',80)],[],now);
      expect(drawn.length).toBeLessThanOrEqual(1);
    }
    expect(l.states.get('higher')?.opacity).toBe(1);
  });
  it('keeps a spacing-only collision departure visible through a brief handoff', () => {
    const l=new PersistentLabels();
    const old={...candidate('old'),box:{x0:100,y0:100,x1:300,y1:220},renderBox:{x0:180,y0:150,x1:220,y1:170}};
    const higher={...candidate('higher',80),box:{x0:100,y0:230,x1:300,y1:350},renderBox:{x0:180,y0:280,x1:220,y1:300}};
    settle(l,[old,higher]);const state=l.states.get('old');
    const moving={...higher,box:{...higher.box,y0:210},renderBox:higher.renderBox};
    const drawn=l.update([old,moving],[],416);
    expect(state?.accepted).toBe(false);expect(state?.opacity).toBeGreaterThan(.9);
    expect(drawn.map(s=>s.id).sort()).toEqual(['higher','old']);
    // The neighbor leaves on the next frame, as at the globe horizon. Painted
    // names never intersected, so do not destroy/recreate or flash the old name.
    l.update([old],[],432,new Set(['higher']));
    expect(l.states.get('old')).toBe(state);expect(state?.accepted).toBe(true);
    expect(state?.opacity).toBe(1);
    // Genuine painted overlap must still suppress the departure immediately.
    for(let at=448;at<=848;at+=16) {
      const drawn=l.update([old,{...moving,renderBox:old.renderBox}],[],at);
      expect(drawn.length).toBeLessThanOrEqual(1);
    }
    expect(l.states.has('old')).toBe(false);
  });
  it('holds a spacing-only departure through a short handoff chain, however long frames take', () => {
    // Zooming out, a neighbour's growing spacing evicts a name; two frames later
    // a third name's spacing evicts that neighbour and the slot is free again.
    // At 100 ms frames a plain fade empties the name in that time: a blink.
    const l=new PersistentLabels();
    const old={...candidate('old',31),box:{x0:100,y0:100,x1:300,y1:220},renderBox:{x0:180,y0:150,x1:220,y1:170}};
    const neighbour={...candidate('neighbour',96),box:{x0:100,y0:230,x1:300,y1:350},renderBox:{x0:180,y0:280,x1:220,y1:300}};
    settle(l,[old,neighbour]);const state=l.states.get('old');
    const close={...neighbour,box:{...neighbour.box,y0:210}};
    for (let frame=0;frame<3;frame++) {
      l.update([old,close],[],1000+frame*100);
      expect(state?.accepted).toBe(false);expect(state?.opacity).toBe(1);
    }
    l.update([old],[],1300,new Set(['neighbour']));
    expect(l.states.get('old')).toBe(state);expect(state?.accepted).toBe(true);expect(state?.opacity).toBe(1);
  });

  it('fades a lasting spacing-only departure after its hold, and hides painted overlap at once', () => {
    const l=new PersistentLabels(32,250,20,6);
    const old={...candidate('old',31),box:{x0:100,y0:100,x1:300,y1:220},renderBox:{x0:180,y0:150,x1:220,y1:170}};
    const higher={...candidate('higher',96),box:{x0:100,y0:210,x1:300,y1:330},renderBox:{x0:180,y0:280,x1:220,y1:300}};
    settle(l,[old]);
    let at=1000;
    for (let frame=0;frame<6;frame++) l.update([old,higher],[],at+=100);
    expect(l.states.get('old')?.opacity).toBe(1);
    for (let frame=0;frame<4;frame++) l.update([old,higher],[],at+=100);
    expect(l.states.has('old')).toBe(false);
    // Painted text overlapping the winner is never held: it fades from the first frame.
    const m=new PersistentLabels();settle(m,[old]);
    m.update([old,{...higher,renderBox:old.renderBox}],[],2000);
    expect(m.states.get('old')?.opacity).toBeLessThan(1);
  });

  it('reserves a bounded render slot for selection ahead of old fading states', () => {
    const l=new PersistentLabels(1);settle(l,[candidate('old')]);
    const selected={...candidate('new'),selected:true,box:{x0:200,y0:0,x1:300,y1:20}};
    const drawn=l.update([candidate('old',50,0),selected],[],500);
    expect(drawn.map(s=>s.id)).toEqual(['new']);
  });
  it('holds contested ownership across zoom reversals, then hands off once with no crossfade', () => {
    const l = new PersistentLabels(); settle(l,[candidate('a'),candidate('b',49)]);
    const winners:string[]=[];
    for(let i=0;i<240;i++) {
      const t=i<120?i:240-i;
      const drawn=l.update([candidate('a',50,.9+t*.01),candidate('b',49+Math.sin(i)*5,1+t*.01)],[],500+i*16);
      expect(drawn.map(s=>s.id)).toEqual(['a']);
      winners.push([...l.states.values()].find(s=>s.accepted)!.id);
    }
    expect(new Set(winners)).toEqual(new Set(['a']));expect(l.handoffs).toBe(0);
    for(let i=0;i<60;i++) {
      const drawn=l.update([candidate('a'),candidate('b',80)],[],4500+i*16);
      expect(drawn.length).toBeLessThanOrEqual(1);
    }
    expect(l.states.get('b')?.opacity).toBe(1);expect(l.handoffs).toBe(1);
  });
  it('requires entry clearance before admitting a neighbor near a contested edge', () => {
    const l=new PersistentLabels();settle(l,[candidate('owner',70)]);
    for(let i=0;i<120;i++) {
      const x=100+Math.sin(i)*3;
      const neighbor={...candidate('neighbor'),box:{x0:x,y0:10,x1:x+90,y1:30}};
      const drawn=l.update([candidate('owner',70),neighbor],[],500+i*16);
      expect(drawn.map(s=>s.id)).toEqual(['owner']);
    }
    expect(l.enters).toBe(1);expect(l.handoffs).toBe(0);
  });
  it('ordinary omission fades, re-entry keeps leave hysteresis, and invalidation evicts immediately', () => {
    const l=new PersistentLabels();settle(l,[candidate('a')]);
    l.update([],[],500);expect(l.states.get('a')?.opacity).toBeGreaterThan(0);
    for(let i=0;i<10;i++) l.update([candidate('a',50,.8)],[],516+i*16);
    expect(l.states.has('a')).toBe(false);
    settle(l,[candidate('a')],800);
    l.update([],[],1300,new Set(['a']));expect(l.states.size).toBe(0);
  });
  it('budget skips work without emitting a false visibility result and always advances one query', () => {
    let now=0;const budget=new AnnotationBudget(2,()=>now);
    expect(budget.run(()=>{now=3;return false;})).toEqual({value:false});
    expect(budget.run(()=>true)).toBeUndefined();
    const next=new AnnotationBudget(0,()=>now);expect(next.run(()=>false)).toEqual({value:false});
  });
});
