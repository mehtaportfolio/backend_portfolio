import { describe, expect, test } from '@jest/globals';
import { isOpenStockHoldingTransaction } from '../services/stockService.js';

describe('isOpenStockHoldingTransaction', () => {
  test('treats rows with no sell date as open', () => {
    expect(isOpenStockHoldingTransaction({ equity_type: 'stock', account_type: 'regular', sell_date: null })).toBe(true);
    expect(isOpenStockHoldingTransaction({ equity_type: 'stocks', account_type: 'FREE', sell_date: null })).toBe(true);
    expect(isOpenStockHoldingTransaction({ equity_type: 'stock', account_type: 'regular', sell_date: '' })).toBe(true);
  });

  test('treats sold positions as closed', () => {
    expect(isOpenStockHoldingTransaction({ equity_type: 'etf', account_type: 'regular', sell_date: null })).toBe(true);
    expect(isOpenStockHoldingTransaction({ equity_type: 'stock', account_type: 'regular', sell_date: '2024-01-01' })).toBe(false);
  });
});
