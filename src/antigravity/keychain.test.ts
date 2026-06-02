import { expect, it } from 'bun:test';
import { parsePassword } from './keychain.ts';

it('should parse escaped keychain password output without greedy capture', () => {
    const stderr = '"labl"<blob>="gemini"\npassword: "go-keyring-base64:abc\\"def"\n"extra"<blob>="ignored"';

    expect(parsePassword(stderr)).toBe('go-keyring-base64:abc"def');
});
