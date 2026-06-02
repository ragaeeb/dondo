import { expect, it } from 'bun:test';
import { assertAccountKey, redactSecrets } from './errors.ts';

it('should redact token-shaped values from public errors', () => {
    const redacted = redactSecrets(
        'Bearer ya29.secret_token {"access_token":"abc","refresh_token":"def"} password: "plain"',
    );

    expect(redacted).not.toContain('secret_token');
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('def');
    expect(redacted).not.toContain('plain');
    expect(redacted).toContain('Bearer [redacted]');
});

it('should reject whitespace-only and padded account keys', () => {
    expect(() => assertAccountKey('   ')).toThrow();
    expect(() => assertAccountKey(' account ')).toThrow();
    expect(assertAccountKey('account.one@example.com')).toBe('account.one@example.com');
});
