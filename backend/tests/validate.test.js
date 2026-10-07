import { describe, it, expect } from 'vitest';
import {
  stripHtml,
  sanitizeText,
  isValidUUID,
  maxLength,
  validateInput,
} from '../src/utils/validate.js';

// ── stripHtml ────────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('removes a simple tag', () => {
    expect(stripHtml('<b>hello</b>')).toBe('hello');
  });

  it('removes script tags', () => {
    expect(stripHtml('<script>alert("xss")</script>')).toBe('alert("xss")');
  });

  it('removes nested tags', () => {
    expect(stripHtml('<div><p>text</p></div>')).toBe('text');
  });

  it('trims surrounding whitespace', () => {
    expect(stripHtml('  hello  ')).toBe('hello');
  });

  it('returns non-string values unchanged', () => {
    expect(stripHtml(42)).toBe(42);
    expect(stripHtml(null)).toBe(null);
  });

  it.each([
    'a < b and c > d',
    '5 < 6',
    '<a <b>c',
    'x<>y',
    '<<b>>',
    'tag <unclosed',
    '<p>one</p><p>two',
    'no tags at all',
    '',
  ])('matches the former /<[^>]*>/g regex on %j', (input) => {
    expect(stripHtml(input)).toBe(input.replace(/<[^>]*>/g, '').trim());
  });

  it('stays linear on "<<<<…" (ReDoS)', () => {
    const start = performance.now();
    stripHtml('<'.repeat(200_000));
    expect(performance.now() - start).toBeLessThan(500);
  });
});

// ── sanitizeText ─────────────────────────────────────────────────────────────

describe('sanitizeText', () => {
  it('strips HTML from a string', () => {
    expect(sanitizeText('<b>bold</b>')).toBe('bold');
  });

  it('returns null as-is', () => {
    expect(sanitizeText(null)).toBe(null);
  });

  it('returns undefined as-is', () => {
    expect(sanitizeText(undefined)).toBe(undefined);
  });

  it('converts numbers to sanitized strings', () => {
    expect(sanitizeText(123)).toBe('123');
  });
});

// ── isValidUUID ───────────────────────────────────────────────────────────────

describe('isValidUUID', () => {
  it('accepts a valid v4 UUID', () => {
    expect(isValidUUID('34bc3350-e012-4669-b70f-ae8b1736b12b')).toBe(true);
  });

  it('accepts uppercase UUID', () => {
    expect(isValidUUID('34BC3350-E012-4669-B70F-AE8B1736B12B')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidUUID('')).toBe(false);
  });

  it('rejects a non-UUID string', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
  });

  it('rejects a number', () => {
    expect(isValidUUID(123)).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidUUID(null)).toBe(false);
  });
});

// ── maxLength ─────────────────────────────────────────────────────────────────

describe('maxLength', () => {
  it('returns true when string is within limit', () => {
    expect(maxLength('hello', 10)).toBe(true);
  });

  it('returns true when string is exactly the limit', () => {
    expect(maxLength('hello', 5)).toBe(true);
  });

  it('returns false when string exceeds limit', () => {
    expect(maxLength('hello world', 5)).toBe(false);
  });

  it('returns true for non-string values (no length to check)', () => {
    expect(maxLength(123, 5)).toBe(true);
    expect(maxLength(null, 5)).toBe(true);
  });
});

// ── validateInput ─────────────────────────────────────────────────────────────

describe('validateInput', () => {
  it('returns null errors when all required fields are present', () => {
    const { errors, data } = validateInput(
      { name: 'Alice' },
      { name: { required: true, type: 'string', maxLen: 50 } }
    );
    expect(errors).toBeNull();
    expect(data.name).toBe('Alice');
  });

  it('returns an error when a required field is missing', () => {
    const { errors } = validateInput(
      {},
      { name: { required: true } }
    );
    expect(errors).toContain('name is required');
  });

  it('returns an error when a string exceeds maxLen', () => {
    const { errors } = validateInput(
      { bio: 'a'.repeat(201) },
      { bio: { type: 'string', maxLen: 200 } }
    );
    expect(errors).toContain('bio must be at most 200 characters');
  });

  it('strips HTML from string fields', () => {
    const { data } = validateInput(
      { title: '<b>hello</b>' },
      { title: { type: 'string', maxLen: 100 } }
    );
    expect(data.title).toBe('hello');
  });

  it('validates and converts number fields', () => {
    const { errors, data } = validateInput(
      { price: '25' },
      { price: { type: 'number', min: 1, max: 1000 } }
    );
    expect(errors).toBeNull();
    expect(data.price).toBe(25);
  });

  it('returns error when number is below min', () => {
    const { errors } = validateInput(
      { price: '0' },
      { price: { type: 'number', min: 1 } }
    );
    expect(errors).toContain('price must be at least 1');
  });

  it('returns error when number is above max', () => {
    const { errors } = validateInput(
      { price: '9999' },
      { price: { type: 'number', max: 1000 } }
    );
    expect(errors).toContain('price must be at most 1000');
  });

  it('returns error for invalid UUID', () => {
    const { errors } = validateInput(
      { userId: 'not-a-uuid' },
      { userId: { type: 'uuid' } }
    );
    expect(errors).toContain('userId must be a valid UUID');
  });

  it('accepts a valid UUID', () => {
    const { errors } = validateInput(
      { userId: '34bc3350-e012-4669-b70f-ae8b1736b12b' },
      { userId: { type: 'uuid' } }
    );
    expect(errors).toBeNull();
  });

  it('rejects a value not in the enum list', () => {
    const { errors } = validateInput(
      { status: 'unknown' },
      { status: { enum: ['pending', 'accepted', 'rejected'] } }
    );
    expect(errors).toContain('status must be one of: pending, accepted, rejected');
  });

  it('accepts a value that is in the enum list', () => {
    const { errors } = validateInput(
      { status: 'accepted' },
      { status: { enum: ['pending', 'accepted', 'rejected'] } }
    );
    expect(errors).toBeNull();
  });

  it('passes through optional fields that are absent', () => {
    const { errors, data } = validateInput(
      {},
      { description: { type: 'string', maxLen: 500 } }
    );
    expect(errors).toBeNull();
    expect(data.description).toBeUndefined();
  });
});
