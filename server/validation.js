export const validText = (value, max = 10000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
