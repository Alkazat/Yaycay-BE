// Cursor-based pagination: ?cursor=&limit= -> { items, nextCursor }.
// The cursor is an opaque base64 offset; nextCursor is present only when a full
// page was returned.

import { badRequest } from './http.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface PageParams {
  offset: number;
  limit: number;
}

export function parsePageParams(url: URL): PageParams {
  const limitRaw = url.searchParams.get('limit');
  let limit = limitRaw ? Number(limitRaw) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const cursor = url.searchParams.get('cursor');
  let offset = 0;
  if (cursor) {
    try {
      const decoded = JSON.parse(atob(cursor)) as { o?: number };
      offset = Number(decoded.o);
      if (!Number.isInteger(offset) || offset < 0) throw new Error('bad');
    } catch {
      throw badRequest('Invalid cursor.');
    }
  }
  return { offset, limit };
}

export function page<T>(items: T[], params: PageParams): { items: T[]; nextCursor: string | null } {
  const nextCursor =
    items.length === params.limit
      ? btoa(JSON.stringify({ o: params.offset + params.limit }))
      : null;
  return { items, nextCursor };
}

/** Inclusive range end for a Supabase `.range(from, to)` call. */
export function rangeEnd(params: PageParams): number {
  return params.offset + params.limit - 1;
}
