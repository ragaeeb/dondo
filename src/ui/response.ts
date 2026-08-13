export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

export const responseErrorMessage = (payload: unknown, response: Response) => {
    if (isRecord(payload) && typeof payload.error === 'string' && payload.error.trim()) {
        return payload.error;
    }
    return response.statusText || `Request failed with status ${response.status}`;
};
