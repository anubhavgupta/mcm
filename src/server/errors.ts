export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected server error.';
}
