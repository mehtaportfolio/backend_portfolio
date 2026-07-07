import { beforeAll, describe, expect, it } from '@jest/globals';

let buildPositionSyncPlan;

beforeAll(async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
  process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'dummy-key';
  ({ buildPositionSyncPlan } = await import('../services/angelOneService.js'));
});

describe('buildPositionSyncPlan', () => {
  it('returns updates for matching symbols when force refresh is enabled', () => {
    const formatted = [
      {
        symbol: 'HDFCSML250-EQ',
        quantity: 2,
        average_price: 180.57,
      },
    ];
    const existingToday = [
      {
        symbol: 'HDFCSML250-EQ',
        quantity: 2,
        average_price: 180.57,
      },
    ];

    const plan = buildPositionSyncPlan(formatted, existingToday, { forceRefresh: true });

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toEqual([
      expect.objectContaining({ symbol: 'HDFCSML250-EQ' }),
    ]);
  });

  it('skips unchanged symbols when force refresh is disabled', () => {
    const formatted = [
      {
        symbol: 'HDFCSML250-EQ',
        quantity: 2,
        average_price: 180.57,
      },
    ];
    const existingToday = [
      {
        symbol: 'HDFCSML250-EQ',
        quantity: 2,
        average_price: 180.57,
      },
    ];

    const plan = buildPositionSyncPlan(formatted, existingToday, { forceRefresh: false });

    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });
});
