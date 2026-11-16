import { describe, expect, it } from 'vitest';
import { guardCell, toCsv } from './csv.js';
import type { Receipt } from './receipt.js';

const base: Receipt = { merchant: 'ร้านกาแฟดี', date: '2026-10-30', currency: 'THB', items: [{ name: 'ลาเต้เย็น', qty: 1, unitPrice: 65, total: 65 }], total: 65 };

describe('csv', () => {
  it('quoting, Thai text UTF-8 BOM, formula injection neutralised', () => {
    const csv = toCsv({ ...base, items: [{ name: 'a,"b"\nc', qty: 2, unitPrice: 1.5, total: 3 }, { name: 'ลาเต้', qty: 1, unitPrice: 65, total: 65 }] });
    expect(csv.startsWith('﻿')).toBe(true); // UTF-8 BOM so Excel reads Thai
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv).toContain('"a,""b""\nc"'); // RFC 4180: quote, double the quotes, keep the newline
    expect(csv).toContain('ลาเต้');
    expect(csv.split('\r\n').every((l) => !l.includes('\r'))).toBe(true);
    for (const p of ['=', '+', '-', '@', '\t', '\r']) {
      const out = toCsv({ ...base, merchant: `${p}cmd|' /C calc'!A0` });
      expect(out, JSON.stringify(p)).toContain(`'${p}cmd`);
      expect(out, JSON.stringify(p)).not.toMatch(new RegExp(`(^|[,"])${p === '\t' ? '\\t' : p === '\r' ? '\\r' : '\\' + p}cmd`));
    }
  });
  it('guardCell prefixes only the listed leading characters', () => {
    expect(guardCell('=1+1')).toBe("'=1+1");
    expect(guardCell('\t=1')).toBe("'\t=1");
    expect(guardCell('\r+1')).toBe("'\r+1");
    expect(guardCell('\n=1')).toBe("'\n=1");
    expect(guardCell('  =1')).toBe("'  =1");
    expect(guardCell('\u3000-1')).toBe("'\u3000-1");
    expect(guardCell('＝1')).toBe("'＝1");
    expect(guardCell('＠x')).toBe("'＠x");
    expect(guardCell('latte -1')).toBe('latte -1');
    expect(guardCell('a\t=1')).toBe('a\t=1');
    expect(guardCell('')).toBe('');
  });
});
