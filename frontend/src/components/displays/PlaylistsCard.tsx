import type { PlaylistRow } from "../../api/types";
import { EmptyNote } from "../EmptyNote";
import { PageCard } from "../PageCard";
import { RowActions } from "../RowActions";
import { TrashButton } from "../TrashButton";
import { countText, skippedText, skipSentence } from "./displayText";

export const NO_PLAYLISTS = "No playlists yet.";

/**
 * The "Playlists" card (w28): name, how many dashboards, and, only when some are skipped, "2 items are skipped" with a line per skipped item saying why.
 * The row menu holds Edit; Delete is the trash button beside it, named for the playlist.
 */
export function PlaylistsCard({ playlists, onEdit, onDelete }: {
  playlists: readonly PlaylistRow[];
  onEdit: (playlist: PlaylistRow) => void;
  onDelete: (playlist: PlaylistRow) => void;
}) {
  return (
    <PageCard className="displays-card" icon="layers" title="Playlists" purpose="The dashboards a screen shows, one after the other.">
      {playlists.length === 0 ? (
        <EmptyNote icon="layers">{NO_PLAYLISTS}</EmptyNote>
      ) : (
        <div className="table-wrap">
          <table className="displays-table">
            <thead><tr><th>Name</th><th>Dashboards</th><th>Skipped</th><th className="act">Actions</th></tr></thead>
            <tbody>
              {playlists.map((p) => (
                <tr key={p.id}>
                  <td className="displays-name" title={p.name}>{p.name}</td>
                  <td className="displays-count">{countText(p.item_count, "dashboard")}</td>
                  <td className="displays-skipped">
                    {p.skipped_count > 0 && (
                      <>
                        <span className="playlist-skipped">{skippedText(p.skipped_count)}</span>
                        <ul className="playlist-skip-list">
                          {p.items.filter((item) => item.skipped !== null).map((item) => <li key={item.id}>{skipSentence(item)}</li>)}
                        </ul>
                      </>
                    )}
                  </td>
                  <td className="act">
                    <div className="displays-act">
                      <RowActions label={`Actions for ${p.name}`} items={[{ label: "Edit", onSelect: () => onEdit(p) }]} />
                      <TrashButton label={`Delete ${p.name}`} onClick={() => onDelete(p)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageCard>
  );
}
