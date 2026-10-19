/* Shared browser transport. Endpoint-specific payload handling stays with callers. */
window.apiFetch = async function apiFetch(url, options = {}) {
  const { timeoutMs = 120000, ...init } = options;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  let response;
  try {
    response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal });
  } catch (error) {
    if (signal.aborted) {
      throw new Error('Request timed out or was cancelled. Refresh job status before retrying a submission.', { cause: error });
    }
    throw new Error('Could not reach the server. Check your connection and retry.', { cause: error });
  }
  if (response.status === 401) {
    location.assign('/login');
    throw new Error('Your session expired. Sign in again.');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    const requestId = response.headers.get('x-request-id');
    const message = response.ok ? 'Invalid server response' : `Server unavailable (HTTP ${response.status})`;
    // Preserve status-based conflict handling without exposing proxy HTML to the UI.
    if (!response.ok) {
      return new Response(JSON.stringify({ error: message, requestId }), {
        status: response.status, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(message);
  }
  return response;
};
