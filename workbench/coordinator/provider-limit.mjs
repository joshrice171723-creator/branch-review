const limitPattern = /\b429\b|\brate[-_ ]?limit(?:_error|_exceeded)?\b|\busage[-_ ]limit(?:_reached)?\b|\binsufficient_quota\b|\bquota (?:has been )?(?:reached|exhausted|exceeded)\b|too many requests/i;
const resetPattern = /(?:resets? (?:at|on)|retry (?:at|after)|try again (?:at|after)|["']?(?:reset_at|resets_at|retry_at)["']?\s*:)\s*["']?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})|\d{10,13}\b)/i;

export function annotateProviderFailure(error, {provider, model, stage}) {
  if (error?.providerLimit || !error || (!limitPattern.test(error.message ?? '') &&
      !limitPattern.test(error.code ?? '') && error.status !== 429 && error.statusCode !== 429)) return error;
  const value = error.resetAt ?? resetPattern.exec(error.message ?? '')?.[1];
  const epoch = /^\d{10,13}$/.test(value ?? '') ? Number(value) * (String(value).length === 10 ? 1000 : 1) : Date.parse(value);
  const date = new Date(epoch);
  error.providerLimit = {provider, model, stage, resetAt: Number.isFinite(date.valueOf()) ? date.toISOString() : null};
  return error;
}
