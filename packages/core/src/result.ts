/**
 * Explicit success/failure without exceptions.
 *
 * Trading code has too many expected failure modes — rejected orders, stale
 * feeds, tripped breakers — for `throw` to be the right tool. An exception
 * that escapes a tick handler can leave a position unmanaged; a Result forces
 * the caller to decide at the call site.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Wrap a throwing call at an integration boundary. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
