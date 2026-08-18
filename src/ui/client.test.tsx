import { expect, it } from 'bun:test';
import { minimaxCheckInAllMessage, minimaxCheckInMessage, minimaxLoadSuccessMessage } from './client.tsx';

it('should describe aggregate MiniMax check-in results without account details', () => {
    expect(
        minimaxCheckInAllMessage({
            alreadyClaimed: 2,
            attempted: 7,
            claimed: 3,
            failed: 1,
            unavailable: 1,
        }),
    ).toBe('Checked in all MiniMax accounts: 3 claimed, 2 already checked in, 1 unavailable, 1 failed (7 attempted)');
});

it('should include the automatic MiniMax check-in outcome in the load message', () => {
    expect(
        minimaxLoadSuccessMessage('primary', {
            checkIn: {
                alreadyClaimed: true,
                claimed: false,
                dayNo: 4,
                points: 400,
                status: 'claimed',
            },
            ok: true,
        }),
    ).toBe('Loaded primary; already checked in today for 400 credits');
});

it('should describe a claimable MiniMax check-in explicitly', () => {
    expect(
        minimaxCheckInMessage({
            alreadyClaimed: false,
            claimed: false,
            dayNo: 4,
            points: 400,
            status: 'claimable',
        }),
    ).toBe('check-in is ready to claim');
});
