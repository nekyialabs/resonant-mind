import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCompassHold } from '../src/regions/compass';
import { imageErrorMessage, ImageSizeLimitError } from '../src/shared/image-security';
import type { Env } from '../src/types';

afterEach(() => vi.restoreAllMocks());

describe('compass_hold failure text', () => {
  it('logs the cause and returns generic text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error('connection to db-internal.example:5432 refused');
    const DB = {
      prepare(sql: string) {
        const s = {
          bind() { return s; },
          async first() {
            if (/FROM compass WHERE id/.test(sql)) return { id: 3, content: 'be kind' };
            throw cause;
          },
        };
        return s;
      },
    };

    const out = await handleCompassHold({ DB } as unknown as Env, { compass_id: 3 });

    expect(out).toBe('Holding: be kind — but persisting the hold FAILED');
    expect(log).toHaveBeenCalledWith('[compass] persisting provenance failed', cause);
  });
});

describe('imageErrorMessage', () => {
  it('passes through the module\'s own messages', () => {
    expect(imageErrorMessage(new Error('PNG has invalid dimensions'), 'fallback')).toBe('PNG has invalid dimensions');
    expect(imageErrorMessage(new ImageSizeLimitError('too big'), 'fallback')).toBe('too big');
  });

  it('uses the fixed fallback for non-Error and low-level throws', () => {
    expect(imageErrorMessage('boom at 10.0.0.5', 'fallback')).toBe('fallback');
    expect(imageErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(imageErrorMessage(new TypeError('x is undefined at /srv/app'), 'fallback')).toBe('fallback');
    expect(imageErrorMessage(new RangeError('Invalid typed array length'), 'fallback')).toBe('fallback');
    class Custom extends Error {}
    expect(imageErrorMessage(new Custom('subclass detail'), 'fallback')).toBe('fallback');
  });
});
