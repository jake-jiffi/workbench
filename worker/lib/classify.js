'use strict';
// Is an error the account's fault (a limit, a sign-in problem) or the worker's? Only structured error fields and
// the text of failed results are classified, never ordinary assistant prose that happens to mention a limit.

// Text is a fallback for when the structured fields (api_error_status, api_error) are absent. A bare status number
// is never enough: it must sit right after an API error marker, so prose that mentions 401 or 429 is not an error.
const CODE = n => new RegExp(`(?:api error|http(?: status)?|status(?: code)?|error code|error)\\s*[:=]?\\s*${n}\\b`, 'i');
const AUTH = /authentication_failed|invalid[ _]api[ _]key|not logged in|please run \/login|oauth token (?:has )?expired|invalid authentication credentials|failed to authenticate/i;
const AUTH_CODE = CODE(401);
const LIMIT = /rate_limit_error|rate_limit|usage_limit_reached|usage limit|limit reached|hit your (?:\w+ )?limit|out of (?:extra )?usage|5-hour limit|weekly limit|session limit|too many requests|billing_error|credit balance is too low|exceeded your (?:\w+ )?limit/i;
const LIMIT_CODE = CODE(429);
const TRANSIENT = /overloaded_error|\boverloaded\b|api_error\b|internal server error|bad gateway|service unavailable|gateway time-?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|request timed out|timed out/i;
const TRANSIENT_CODE = /(?:api error|http(?: status)?|status(?: code)?|error code|error)\s*[:=]?\s*(?:5\d\d)\b/i;

/** 'limit' | 'auth' | 'transient' | null, from text alone. Limit and auth outrank transient. */
function classifyText(text) {
  const t = String(text || '');
  if (!t) return null;
  if (AUTH.test(t) || AUTH_CODE.test(t)) return 'auth';
  if (LIMIT.test(t) || LIMIT_CODE.test(t)) return 'limit';
  if (TRANSIENT.test(t) || TRANSIENT_CODE.test(t)) return 'transient';
  return null;
}

/**
 * The structured fields of a result event: api_error_status (HTTP status) and api_error (a name). Returns
 * 'limit' | 'auth' | 'transient', 'other' when the fields are present but say nothing about the account or the
 * service, or null when both are absent (use the text).
 */
function classifyStructured(status, apiError) {
  const hasS = status !== undefined && status !== null, hasE = typeof apiError === 'string' && apiError !== '';
  if (!hasS && !hasE) return null;
  const e = hasE ? apiError.toLowerCase() : '';
  const n = hasS ? Number(status) : NaN;
  if (n === 429 || /usage_limit|rate_limit|billing/.test(e)) return 'limit';
  if (n === 401 || /authentication|permission_denied|invalid_api_key|oauth/.test(e)) return 'auth';
  if ((n >= 500 && n <= 599) || /overloaded|api_error|server_error|timeout|timed_out|connection/.test(e)) return 'transient';
  return 'other';
}

/** The value of an assistant message's top-level `error` field. */
function classifyField(v) {
  switch (v) {
    case 'rate_limit': case 'billing_error': return 'limit';
    case 'authentication_failed': return 'auth';
    case 'server_error': return 'transient';
    default: return null;
  }
}

/** A stated reset in a limit message: `...|1794808800` (epoch seconds). Returns ms or null. */
function resetFromText(text) {
  const m = /\|\s*(\d{10})\b/.exec(String(text || ''));
  if (m) return Number(m[1]) * 1000;
  return null;
}

module.exports = { classifyText, classifyStructured, classifyField, resetFromText };
