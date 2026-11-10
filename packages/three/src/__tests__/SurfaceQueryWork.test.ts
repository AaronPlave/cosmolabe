import { expect, it, vi } from 'vitest';
import { surfaceQueryWork } from '../surface/SurfaceQueryWork.js';

it('yields on elapsed time and observes Stop delivered by the next task', async () => {
  let clock=0;
  const now=vi.spyOn(performance,'now').mockImplementation(()=>clock);
  const controller=new AbortController();
  const work=surfaceQueryWork(controller.signal);
  try {
    await work.checkpoint();
    clock=9;
    setTimeout(()=>controller.abort(),0);
    await expect(work.checkpoint()).rejects.toMatchObject({name:'AbortError'});
  } finally {now.mockRestore();}
});
