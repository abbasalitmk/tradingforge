import { describe, it, expect } from 'vitest';
import { getStrategy } from '@tradeforger/strategy';
import { StrategyRegistry } from './registry.ts';

function fakeSql(initialRows: unknown[]) {
  const fn = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('SELECT * FROM strategy_versions')) return initialRows;
    if (q.includes('INSERT INTO strategy_versions')) {
      return [{
        id: vals[0], strategy_id: vals[1], version: vals[2], params: {},
        status: 'CANDIDATE', origin: vals[4], hypothesis: vals[5], validation: null,
        created_at: new Date(), validated_at: null, approved_at: null, approved_by: null,
      }];
    }
    return [];
  };
  fn.json = (x: unknown) => x;
  return fn as unknown as ConstructorParameters<typeof StrategyRegistry>[0];
}

describe('StrategyRegistry.activeVerdict', () => {
  it('preserves REJECTED verdict when a failing default v1 is RETIRED', async () => {
    const def = getStrategy('ORB_SUPERTREND')!;
    const rows = [{
      id: 'ORB_SUPERTREND@v1',
      strategy_id: 'ORB_SUPERTREND',
      version: 1,
      params: def.defaults,
      status: 'RETIRED',
      origin: 'DEFAULT',
      hypothesis: null,
      validation: { status: 'REJECTED', outOfSample: { expectancyR: -0.25 } },
      created_at: new Date(),
      validated_at: new Date(),
      approved_at: null,
      approved_by: null,
    }];
    const reg = new StrategyRegistry(fakeSql(rows));
    await reg.load();
    expect(reg.approved('ORB_SUPERTREND')).toBeNull();
    expect(reg.activeVerdict('ORB_SUPERTREND')).toEqual({ status: 'REJECTED', oosExpectancyR: -0.25 });
  });
});
