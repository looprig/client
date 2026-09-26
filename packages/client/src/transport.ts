/** Common options for Factory REST reads and commands. */
export interface RequestOptions { signal?: AbortSignal }
/** Injectable fetch implementation used by Factory clients. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
