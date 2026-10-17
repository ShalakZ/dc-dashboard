import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

/** `GET /api/mappings/{id}/latest`: the newest reading of a mapped point, already multiplied by the mapping's scale. */
export interface MappingLatest {
  mapping_id: number;
  /** Null (like `ts`, `quality` and `age_seconds`) when the point has no reading yet. */
  value: number | null;
  unit: string;
  ts: string | null;
  /** 0 is a good reading. */
  quality: number | null;
  /** The database's clock; the browser only adds the time that passed since the answer (`ageNow`). */
  age_seconds: number | null;
  stale: boolean;
}

const KEEP_MS = 5_000;

/**
 * The last value of one mapping, for the card that shows on a hover. It asks once per hover and never again on its own: no polling, no retry
 * (a failing read shows its error once; the next hover tries again), and the answer is dropped a few seconds after the card is gone.
 * Disabled for a null id, so a card that is not wanted asks nothing.
 */
export const useMappingLatest = (mappingId: number | null) =>
  useQuery({
    queryKey: ["mapping-latest", mappingId],
    queryFn: () => api.get<MappingLatest>(`/api/mappings/${mappingId}/latest`),
    enabled: mappingId !== null,
    staleTime: 0,
    gcTime: KEEP_MS,
    refetchInterval: false,
    retry: false,
  });
