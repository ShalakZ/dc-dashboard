import { useReopenBillingMonth } from "../api/queries";
import type { BillingClosed, BillingLive } from "../api/types";
import { liveDeltaText, monthLabel, UNPRICED_TEXT } from "../lib/billing";
import { MonthDialog } from "./MonthDialog";
import { useToast } from "./Toasts";

/** The shortest reason the server takes (core R7: 5 to 500 characters once trimmed). */
export const MIN_REOPEN_NOTE = 5;

/**
 * Go back to today's figures for a closed month. The reason is required and the audit log records it. The closed figures stay stored but the app shows them
 * nowhere once the month is open again, so the dialog says that, and, when today's figures are not the billed ones (or cannot be priced), by how far, before the click.
 * `closed`, `live` and `currency` are what the page said about the month when the dialog was opened (the page's own line, in the same words).
 */
export function ReopenMonthDialog({ month, closed, live, currency, onClose }: {
  month: string;
  closed: Pick<BillingClosed, "total_cost">;
  live: BillingLive | null | undefined;
  currency: string | null;
  onClose: () => void;
}) {
  const reopen = useReopenBillingMonth();
  const toast = useToast();
  const label = monthLabel(month);
  const difference = !live ? UNPRICED_TEXT : live.differs ? liveDeltaText(live, closed, currency) : null;
  return (
    <MonthDialog
      title={`Reopen ${label}`}
      intro={`Reopen ${label}? The page will show today's figures again. The closed figures stay stored, but the app does not show them once the month is reopened, so download the CSV first if you need them. The reason is recorded in the audit log.`}
      extra={difference}
      noteLabel="Reason"
      minNote={MIN_REOPEN_NOTE}
      confirmLabel="Reopen month"
      onConfirm={async (note) => {
        await reopen.mutateAsync({ month, note });
        toast.success(`${label} reopened`);
        onClose();
      }}
      onCancel={onClose}
    />
  );
}
