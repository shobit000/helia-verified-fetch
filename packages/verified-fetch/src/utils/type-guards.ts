export function isPromise <T> (p?: any): p is Promise<T> {
  return p?.then != null
}
