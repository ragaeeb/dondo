import { expect, it } from 'bun:test';
import { usageToLimitResult } from './usage.ts';

it('maps MiniMax Code 5-hour and weekly quota fields', () => {
    const result = usageToLimitResult(
        {
            model_remains: [
                {
                    current_interval_remaining_percent: 48.4,
                    current_weekly_remaining_percent: 75,
                    end_time: 1_800_000_000,
                    interval_boost_permille: 500,
                    weekly_boost_permille: 1_000,
                    weekly_end_time: 1_800_400_000,
                },
            ],
        },
    );

    expect(result).toEqual({
        expires: '2027-01-19T23:06:40.000Z',
        models: {
            'minimax-5-hour': {
                displayName: '5-hour quota',
                limit: 50,
                percentage: 48,
                resetTime: '2027-01-15T08:00:00.000Z',
                used: 26,
            },
            'minimax-weekly': {
                displayName: 'Weekly quota',
                limit: 100,
                percentage: 75,
                resetTime: '2027-01-19T23:06:40.000Z',
                used: 25,
            },
        },
        ok: true,
        tier: 'MiniMax Code',
    });
});

it('treats MiniMax non-plan access as valid without inventing a numeric quota', () => {
    const result = usageToLimitResult({
        base_resp: {
            status_code: 2062,
            status_msg: 'no active token plan subscription',
        },
        model_remains: undefined,
    });

    expect(result).toEqual({
        expires: '',
        models: {
            'minimax-free-access': {
                detail: 'MiniMax does not report a numeric allowance for non-plan access',
                displayName: 'Free / non-plan access',
                percentage: 0,
                resetTime: '',
            },
        },
        ok: true,
        tier: 'MiniMax Code · no token plan',
    });
});
