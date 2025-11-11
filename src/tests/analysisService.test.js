// Mock supabase-js
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          order: jest.fn(() => ({
            data: null,
            error: null,
          })),
        })),
      })),
    })),
  })),
}));

// Mock fetchAllRows
jest.mock('../db/queries.js', () => ({
  fetchAllRows: jest.fn(),
}));

import { getAnalysisSummary } from '../services/analysisService.js';
import { fetchAllRows } from '../db/queries.js';
import { supabase } from '../db/supabaseClient.js';

describe('getAnalysisSummary MF Aggregation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('handles partial exits - active and closed portions', async () => {
    // Mock data: Buy 100 units, sell 50 units
    const mockMfTxns = [
      {
        fund_short_name: 'Test Fund',
        account_name: 'Account1',
        transaction_type: 'Buy',
        units: 100,
        nav: 10,
        date: '2023-01-01',
      },
      {
        fund_short_name: 'Test Fund',
        account_name: 'Account1',
        transaction_type: 'Sell',
        units: -50,
        nav: 12,
        date: '2023-06-01',
      },
    ];
    const mockFundMaster = [
      {
        fund_short_name: 'Test Fund',
        cmp: 15,
        lcp: 14,
        category: 'Equity',
        amc_name: 'Test AMC',
      },
    ];

    fetchAllRows
      .mockImplementationOnce(() => Promise.resolve({ data: [] })) // stock txns
      .mockImplementationOnce(() => Promise.resolve({ data: [] })) // stock master
      .mockImplementationOnce(() => Promise.resolve({ data: mockMfTxns })) // mf txns
      .mockImplementationOnce(() => Promise.resolve({ data: mockFundMaster })); // fund master

    const result = await getAnalysisSummary();

    expect(result.mfActive).toHaveLength(1);
    expect(result.mfClosed).toHaveLength(1);

    // Active: 50 units remaining
    const active = result.mfActive[0];
    expect(active.units).toBe(50);
    expect(active.invested).toBe(500); // 50 * 10
    expect(active.marketValue).toBe(50 * 15); // 50 * 15

    // Closed: 50 units sold
    const closed = result.mfClosed[0];
    expect(closed.units).toBe(50);
    expect(closed.invested).toBe(500); // 50 * 10
    expect(closed.closedValue).toBe(50 * 12); // 50 * 12
  });

  test('handles multiple accounts per scheme', async () => {
    const mockMfTxns = [
      {
        fund_short_name: 'Test Fund',
        account_name: 'Account1',
        transaction_type: 'Buy',
        units: 100,
        nav: 10,
        date: '2023-01-01',
      },
      {
        fund_short_name: 'Test Fund',
        account_name: 'Account2',
        transaction_type: 'Buy',
        units: 100,
        nav: 10,
        date: '2023-01-01',
      },
    ];
    const mockFundMaster = [
      {
        fund_short_name: 'Test Fund',
        cmp: 15,
        lcp: 14,
        category: 'Equity',
        amc_name: 'Test AMC',
      },
    ];

    fetchAllRows
      .mockImplementationOnce(() => Promise.resolve({ data: [] })) // stock txns
      .mockImplementationOnce(() => Promise.resolve({ data: [] })) // stock master
      .mockImplementationOnce(() => Promise.resolve({ data: mockMfTxns })) // mf txns
      .mockImplementationOnce(() => Promise.resolve({ data: mockFundMaster })); // fund master

    const result = await getAnalysisSummary();

    expect(result.mfActive).toHaveLength(2); // Two accounts
    expect(result.mfClosed).toHaveLength(0);

    // Check both accounts have 100 units each
    const accounts = result.mfActive.map(a => a.account_name).sort();
    expect(accounts).toEqual(['Account1', 'Account2']);
    result.mfActive.forEach(active => {
      expect(active.units).toBe(100);
      expect(active.invested).toBe(1000);
    });
  });

  test('handles empty sale streams - no closed records emitted', async () => {
    const mockMfTxns = [
      {
        fund_short_name: 'Test Fund',
        account_name: 'Account1',
        transaction_type: 'Buy',
        units: 100,
        nav: 10,
        date: '2023-01-01',
      },
    ];
    const mockFundMaster = [
      {
        fund_short_name: 'Test Fund',
        cmp: 15,
        lcp: 14,
        category: 'Equity',
        amc_name: 'Test AMC',
      },
    ];

    fetchAllRows
      .mockImplementationOnce(() => Promise.resolve({ data: [] })) // stock txns
      .mockImplementationOnce(() => Promise.resolve({ data: [] })) // stock master
      .mockImplementationOnce(() => Promise.resolve({ data: mockMfTxns })) // mf txns
      .mockImplementationOnce(() => Promise.resolve({ data: mockFundMaster })); // fund master

    const result = await getAnalysisSummary();

    expect(result.mfActive).toHaveLength(1);
    expect(result.mfClosed).toHaveLength(0);

    const active = result.mfActive[0];
    expect(active.units).toBe(100);
    expect(active.invested).toBe(1000);
  });
});