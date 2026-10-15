import { useReopenBillingMonth } from "../api/queries";
import { monthLabel } from "../lib/billing";
import { MonthDialog } from "./MonthDialog";
import { useToast } from "./Toasts";

/** The shortest reason the server takes (core R7: 5 to 500 characters once trimmed). */
export const MIN_REOPEN_NOTE = 5;

/** Go back to live figures for a closed month. The reason is required; the closed figures are kept and the audit log records it. */
export function ReopenMonthDialog({ month, onClose }: { month: string; onClose: () => void }) {
  const reopen = useReopenBillingMonth();
  const toast = useToast();
  const label = monthLabel(month);
  return (
    <MonthDialog
      title={`Reopen ${label}`}
      intro={`Reopen ${label}? The page will show live figures again. The closed figures are kept and the reason is recorded in the audit log.`}
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
