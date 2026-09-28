import { describe, test, expect, afterEach } from 'bun:test';
import { checkApiKeyExists } from './env.js';

/**
 * `.env` ships placeholder values like `your-perplexity-api-key`. The registry
 * used to gate providers on a bare `process.env.X` truthiness check, so a
 * placeholder registered as a working provider and the web_search fallback
 * chain spent a call on a guaranteed 401 before moving on.
 */
describe('checkApiKeyExists', () => {
  const NAME = 'RUBO_TEST_KEY_ONLY';
  afterEach(() => {
    delete process.env[NAME];
  });

  test('a real value counts', () => {
    process.env[NAME] = 'sk-live-abc123';
    expect(checkApiKeyExists(NAME)).toBe(true);
  });

  test('an unset key does not', () => {
    expect(checkApiKeyExists(NAME)).toBe(false);
  });

  test('a your-... placeholder does not', () => {
    process.env[NAME] = 'your-perplexity-api-key';
    expect(checkApiKeyExists(NAME)).toBe(false);
  });

  test('whitespace does not', () => {
    process.env[NAME] = '   ';
    expect(checkApiKeyExists(NAME)).toBe(false);
  });
});
