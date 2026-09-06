export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // A disconnected backend may return a non-JSON proxy response.
    }
    throw new Error(message);
  }
  return response.json();
}

export function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(value) };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
