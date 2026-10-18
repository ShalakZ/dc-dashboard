import { useCloseBillingMonth } from "../api/queries";
import { monthLabel } from "../lib/billing";
import { MonthDialog } from "./MonthDialog";
import { useToast } from "./Toasts";

/**
 * Freeze a finished month. The note is optional. The request is answered after the month has been read again (the mutation waits for its
 * invalidation), so when the dialog closes the page already shows the closed month. A refusal (already closed, not over yet, no data) stays in the dialog.
 * `checkLine` is one plain line about the month check, worded by the page at the click (it never changes while the dialog is open); it adds no control.
 */
export function CloseMonthDialog({ month, onClose, checkLine }: { month: string; onClose: () => void; checkLine?: string }) {
  const close = useCloseBillingMonth();
  const toast = useToast();
  const label = monthLabel(month);
  return (
    <MonthDialog
      title={`Close ${label}`}
      intro={`Freeze the figures of ${label} as they are now. Later changes to assets, mappings or rates will not change them. You can reopen the month later, with a reason.`}
      noteLabel="Note (optional)"
      minNote={0}
      extra={checkLine}
      confirmLabel="Close month"
      onConfirm={async (note) => {
        await close.mutateAsync({ month, note });
        toast.success(`${label} closed`);
        onClose();
      }}
      onCancel={onClose}
    />
  );
}
