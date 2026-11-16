import { describe, expect, it } from 'vitest';
import { maskPii, normalizeForDedup, screenText } from './screen.js';

describe('screenText (K13)', () => {
  it('refuses a secret-shaped text and a configured secret literal', () => {
    expect(screenText('token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', { max: 400 })).toMatchObject({ ok: false });
    expect(screenText('the password is hunter2hunter2', { max: 400, secrets: ['hunter2hunter2'] })).toMatchObject({ ok: false });
    expect(screenText('postgres://user:pw@host/db', { max: 400 })).toMatchObject({ ok: false });
  });
  it('refuses invisible and control characters, empty text and over-long text', () => {
    expect(screenText('a​b', { max: 400 })).toMatchObject({ ok: false });
    expect(screenText('a\u0007b', { max: 400 })).toMatchObject({ ok: false });
    expect(screenText('   ', { max: 400 })).toMatchObject({ ok: false });
    expect(screenText('x'.repeat(401), { max: 400 })).toMatchObject({ ok: false });
    expect(screenText('a\nb', { max: 400, multiline: false })).toMatchObject({ ok: false });
  });
  it('masks email, phone, national id and card numbers, but leaves dates, prices and ids alone', () => {
    expect(maskPii('mail a.b+c@x.co.th now')).toBe('mail [email] now');
    expect(maskPii('call +66 81 234 5678')).toBe('call [phone]');
    expect(maskPii('call 081-234-5678.')).toBe('call [phone].');
    expect(maskPii('id 1-1001-12345-67-8 ok')).toBe('id [id] ok');
    expect(maskPii('card 4111 1111 1111 1111 ok')).toBe('card [card] ok');
    expect(maskPii('card 4111 1111 1111 1112 ok')).toBe('card 4111 1111 1111 1112 ok'); // fails Luhn: not a card
    expect(maskPii('released on 2026-11-02 for 1,200 baht, task 12345')).toBe('released on 2026-11-02 for 1,200 baht, task 12345');
  });
  it('pii:false leaves the text as written (prompt bodies)', () => {
    expect(screenText('mail me a@b.co', { max: 100, pii: false })).toEqual({ ok: true, text: 'mail me a@b.co', masked: false });
  });
  it('normalizes for the duplicate check', () => {
    expect(normalizeForDedup('Hello,  WORLD!!')).toBe(normalizeForDedup('hello world'));
  });
});
