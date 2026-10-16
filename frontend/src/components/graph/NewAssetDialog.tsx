import type { Asset, AssetIn, AssetKind } from "../../api/types";
import { AssetForm } from "../AssetForm";
import { Modal } from "../Modal";

/** No asset is left out of the Parent list: this form only ever makes a new asset, which has no descendants to exclude. */
const NONE = new Set<number>();

/** Said above the form when a Review follows: saving makes the asset at once, and a cancelled Review does not take it back. */
const CONTINUES = "Next you choose the points to map. Cancel keeps the new asset.";

/**
 * The real asset form (AssetForm: name, parent, kind, icon) in a dialog, for the places on the Discovery canvas that make an asset: the pane's
 * New asset, an asset's New sub-asset, and a group or unmapped point whose Review follows (`continues`).
 *
 * `create` is the save (hooks/useCreateAsset); an error it throws is the form's own to show, so nothing is caught here. `onCreated` gets the saved
 * asset; the caller closes this dialog and carries on (it opens the Review for `continues`). `canRegister` is assets.kinds, passed on to the form.
 * The note exists from the first paint and never changes, so it needs no reserved slot; it is a plain line (not a live region: the dialog has
 * one announcer). The form is keyed by what it starts from, so a dialog that stays mounted and is opened for another name or parent starts fresh.
 */
export function NewAssetDialog({ assets, kinds, name, parentId, continues, canRegister, create, onCreated, onCancel }: {
  assets: Asset[]; kinds: AssetKind[];
  /** Prefilled in Name: the group's label, the point's name. */
  name?: string;
  /** Preselected in Parent; null = none. */
  parentId: number | null;
  /** A Review opens after the save. */
  continues: boolean;
  canRegister: boolean;
  create: (body: AssetIn, registerKind: boolean) => Promise<Asset>;
  onCreated: (asset: Asset) => void;
  onCancel: () => void;
}) {
  return (
    <Modal title="New asset" onClose={onCancel}>
      {continues && <p className="muted">{CONTINUES}</p>}
      <AssetForm
        key={`${parentId ?? "none"}:${name ?? ""}`}
        assets={assets}
        kinds={kinds}
        initial={{ name, parent_id: parentId }}
        excludeIds={NONE}
        canRegister={canRegister}
        onSubmit={async (body, registerKind) => { onCreated(await create(body, registerKind)); }}
        onCancel={onCancel}
      />
    </Modal>
  );
}
