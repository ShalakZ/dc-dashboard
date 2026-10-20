import type { DisplayRow } from "../../api/types";
import { useNow } from "../../hooks/useNow";
import { EmptyNote } from "../EmptyNote";
import { PageCard } from "../PageCard";
import { RowActions } from "../RowActions";
import { TrashButton } from "../TrashButton";
import { lastConnectedParts, lastConnectedText } from "./displayText";

export const NO_SCREENS = "No screens yet. Make a playlist, then add a display.";

/** Two muted lines: "3 min ago" and "from 10.0.0.12" (an address may break anywhere). A real space between them keeps the cell's text one sentence. */
function WhenCell({ screen, now, timezone }: { screen: DisplayRow; now: Date; timezone: string }) {
  const { when, from } = lastConnectedParts(screen, now, timezone);
  return from === null ? <>{when}</> : <><span>{when}</span>{" "}<span className="displays-from">{from}</span></>;
}

/**
 * The "Screens" card (w28): one row per display with its playlist, Active or Revoked and when it last connected. The Last connected cell is "3 min ago" over
 * "from 10.0.0.12" (its title holds the whole sentence) and is recounted every 30 s (a screen that has gone quiet sends nothing to re-render on). The row menu
 * holds Rename, Change playlist and Revoke (off for a screen that is revoked already); Delete is the trash button beside it, named for the screen, as on the
 * Dashboards page.
 */
export function ScreensCard({ screens, timezone, onRename, onChangePlaylist, onRevoke, onDelete }: {
  screens: readonly DisplayRow[];
  timezone: string;
  onRename: (screen: DisplayRow) => void;
  onChangePlaylist: (screen: DisplayRow) => void;
  onRevoke: (screen: DisplayRow) => void;
  onDelete: (screen: DisplayRow) => void;
}) {
  const now = new Date(useNow(30_000));
  return (
    <PageCard className="displays-card" icon="screen" title="Screens" purpose="Each screen opens its own link and shows one playlist.">
      {screens.length === 0 ? (
        <EmptyNote icon="screen">{NO_SCREENS}</EmptyNote>
      ) : (
        <div className="table-wrap">
          <table className="displays-table">
            <thead><tr><th>Name</th><th>Playlist</th><th>Status</th><th>Last connected</th><th className="act">Actions</th></tr></thead>
            <tbody>
              {screens.map((s) => (
                <tr key={s.id}>
                  <td className="displays-name" title={s.name}>{s.name}</td>
                  <td className="displays-playlist" title={s.playlist_name}>{s.playlist_name}</td>
                  <td>{s.status === "active" ? <span className="chip chip-ok">Active</span> : <span className="chip chip-off">Revoked</span>}</td>
                  <td className="displays-when" title={lastConnectedText(s, now, timezone)}><WhenCell screen={s} now={now} timezone={timezone} /></td>
                  <td className="act">
                    <div className="displays-act">
                      <RowActions
                        label={`Actions for ${s.name}`}
                        items={[
                          { label: "Rename", onSelect: () => onRename(s) },
                          { label: "Change playlist", onSelect: () => onChangePlaylist(s) },
                          { label: "Revoke", onSelect: () => onRevoke(s), disabled: s.status === "revoked" },
                        ]}
                      />
                      <TrashButton label={`Delete ${s.name}`} onClick={() => onDelete(s)} />
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
