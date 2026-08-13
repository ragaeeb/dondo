import { expect, it } from 'bun:test';
import { usageToLimitResult } from './usage.ts';

it('should expose Kiro usage with absolute and remaining quota values', () => {
    expect(
        usageToLimitResult({
            nextDateReset: 1_800_000_000,
            subscriptionInfo: { subscriptionTitle: 'Kiro Free' },
            usageBreakdownList: [
                {
                    currentUsageWithPrecision: 48.4,
                    displayNamePlural: 'Credits',
                    resourceType: 'CREDIT',
                    usageLimitWithPrecision: 50,
                },
            ],
        }),
    ).toEqual({
        expires: '2027-01-15T08:00:00.000Z',
        models: {
            credit: {
                displayName: 'Credits',
                limit: 50,
                percentage: 3,
                resetTime: '2027-01-15T08:00:00.000Z',
                used: 48.4,
            },
        },
        ok: true,
        tier: 'Kiro Free',
    });
});

it('should omit Kiro usage entries without a positive limit', () => {
    expect(
        usageToLimitResult({
            usageBreakdownList: [
                { resourceType: 'UNLIMITED', usageLimit: 0 },
                { currentUsage: 2, resourceType: 'CREDIT', usageLimit: 10 },
            ],
        }),
    ).toMatchObject({
        models: {
            credit: { limit: 10, percentage: 80, used: 2 },
        },
        ok: true,
    });
});

it('should clamp negative Kiro usage values to zero', () => {
    const result = usageToLimitResult({
        usageBreakdownList: [{ currentUsage: -5, resourceType: 'CREDIT', usageLimit: 10 }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
        expect(result.models.credit).toMatchObject({ limit: 10, percentage: 100, used: 0 });
    }
});

it('should reject Kiro usage when no positive limit is available', () => {
    expect(usageToLimitResult({})).toEqual({ error: 'Kiro usage returned no quota fields', ok: false });
    expect(usageToLimitResult({ usageBreakdownList: [] })).toEqual({
        error: 'Kiro usage returned no quota fields',
        ok: false,
    });
});

it('should fail cleanly for hostile Kiro usage field types', () => {
    expect(
        usageToLimitResult({
            nextDateReset: {},
            subscriptionInfo: { subscriptionTitle: { label: 'poison' } },
            usageBreakdownList: [
                null,
                {
                    currentUsage: 'two',
                    displayName: { label: 'Credits' },
                    resourceType: 123,
                    usageLimit: 'ten',
                },
            ],
        }),
    ).toEqual({ error: 'Kiro usage returned no quota fields', ok: false });
});
