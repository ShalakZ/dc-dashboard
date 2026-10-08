export const ESTIMATED_TIP = "Estimated from average power; this asset has no energy counter.";
export const PARTIAL_TIP = "Partial: some consumption in this period had no rate, so the cost is incomplete.";

/** A number with its marks: `~` before it when estimated, `*` after it when partial. Each mark explains itself on hover. */
export function Figure({ text, estimated, partial }: { text: string; estimated: boolean; partial: boolean }) {
  return (
    <>
      {estimated && <abbr title={ESTIMATED_TIP}>~</abbr>}
      {text}
      {partial && <abbr title={PARTIAL_TIP}>*</abbr>}
    </>
  );
}
