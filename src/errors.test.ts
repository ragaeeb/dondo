import { expect, it } from 'bun:test';
import { assertAccountKey, cleanLimitError, errorStatus, isPublicError, publicError, redactSecrets } from './errors.ts';

it('should redact token-shaped values from public errors', () => {
    const redacted = redactSecrets(
        [
            'Bearer ya29.bearer',
            '{"access_token":"ZZZ1","refresh_token":"ZZZ2","id_token":"ZZZ3"}',
            '{"accessToken":"ZZZ4","refreshToken":"ZZZ5","idToken":"ZZZ6"}',
            '{"clientSecret":"ZZZ7","apiKey":"ZZZ8","OPENAI_API_KEY":"ZZZ9"}',
            '{"password":"ZZZ10","authorization":"ZZZ11"}',
            'password: "ZZZ12"',
            'token=ZZZ13&safe=value',
            'refreshToken=ZZZ14',
        ].join(' '),
    );

    for (const secret of ['ya29.bearer', ...Array.from({ length: 14 }, (_, index) => `ZZZ${index + 1}`)]) {
        expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('Bearer [redacted]');
});

it('should not redact ordinary prose containing credential-related words', () => {
    const prose = 'Refresh token handling and password rotation are documented; authorization is required.';
    expect(redactSecrets(prose)).toBe(prose);
});

it('should reject whitespace-only and padded account keys', () => {
    expect(() => assertAccountKey('   ')).toThrow();
    expect(() => assertAccountKey(' account ')).toThrow();
    expect(assertAccountKey('account.one@example.com')).toBe('account.one@example.com');
});

it('should reject prototype-related account keys', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
        expect(() => assertAccountKey(key)).toThrow();
    }
});

it('should accept only integer client and server error statuses', () => {
    const clientError = publicError(400, 'client');
    expect(isPublicError(clientError)).toBe(true);
    expect(errorStatus(clientError)).toBe(400);
    expect(errorStatus(publicError(599, 'server'))).toBe(599);

    for (const status of [399, 600, 400.5, Number.NaN, Number.POSITIVE_INFINITY, '404', null]) {
        expect(errorStatus({ status })).toBe(500);
    }
    expect(isPublicError({ public: true, status: 400 })).toBe(false);
    expect(errorStatus(new Error('missing status'))).toBe(500);
});

it('should not turn unexpected refresh failures into public state data', () => {
    expect(cleanLimitError(new Error('request failed for /private/path with Bearer ya29.secret'))).toEqual({
        error: 'Could not refresh usage limits',
        ok: false,
    });
    expect(cleanLimitError(publicError(502, 'Usage provider is unavailable'))).toEqual({
        error: 'Usage provider is unavailable',
        ok: false,
    });
});
