/** The one place the mark's URL appears; a later Branding setting swaps this value. */
export const BRAND_MARK_SRC = "/logo-mark.svg";

// The owner's mark is 155 by 150 units, so the width follows the height. An <img> so no theme can tint it; always decorative, because
// every use sits next to the visible name ("DC Dashboard"), which is what a screen reader reads.
export function BrandMark({ size, className = "brand-mark" }: { size: number; className?: string }) {
  return <img className={className} src={BRAND_MARK_SRC} width={Math.round((size * 155) / 150)} height={size} alt="" aria-hidden="true" />;
}
