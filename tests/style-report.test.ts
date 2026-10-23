import { describe, expect, it } from 'vitest';
import { styleReport } from '../src/stages/styleReport.js';

const good = `# STORY_UNITS v1
## BEAT b01
Our guy is pinned on his own bed while his dead girlfriend demands to know which of her faces is prettier. @p0001_1 @p0002_1
But Minjun dodges the trap, telling her to pick whichever look keeps other women from even thinking about stealing him. @p0003_1 @p0004_1
She calls him a genius and smothers him with kisses, demanding he live with her forever after that. @p0005_1 @p0006_1
Way too close. @hold
## BEAT b02
He admits he kept her old apartment exactly as it was, just so her traces would never disappear. @p0007_1 @p0008_1
`;

describe('styleReport (recap target)', () => {
  it('passes a script in the target style', () => {
    const r = styleReport(good);
    const miss = r.metrics.filter((m) => !m.ok).map((m) => m.key);
    expect(miss).toEqual([]);
    expect(r.flags).toEqual([]);
  });

  it('flags then-chains, image description and a viewer question ending', () => {
    const bad = `# STORY_UNITS v1
## BEAT b01
She spots the circle, and then a rift opens and she steps out. @p0001_1
The panel shows her smiling with a close-up of her face. @p0002_1
What do you think happens next? @p0003_1
`;
    const r = styleReport(bad);
    expect(r.flags.some((f) => f.includes('then-chain'))).toBe(true);
    expect(r.flags.some((f) => f.includes('describes the image'))).toBe(true);
    expect(r.metrics.find((m) => m.key === 'lands on the turn')!.ok).toBe(false);
  });
});
