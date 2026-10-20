import { useEffect, useId, useRef, useState } from "react";
import { useDeleteDisplay, useDeletePlaylist, useDisplays, useRevokeDisplay, useSite } from "../api/queries";
import type { DisplayRow, PlaylistRow } from "../api/types";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { DisplayFieldDialog } from "../components/displays/DisplayFieldDialog";
import { NewDisplayDialog } from "../components/displays/NewDisplayDialog";
import { PlaylistDialog } from "../components/displays/PlaylistDialog";
import { PlaylistsCard } from "../components/displays/PlaylistsCard";
import { playlistDeleteRefusal } from "../components/displays/displayText";
import { ScreensCard } from "../components/displays/ScreensCard";
import { Icon, type IconName } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { PageCardSkeleton, SkeletonRegion, TableSkeleton, TilesSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { upperFirst } from "../lib/upperFirst";

/** A server refusal, which is written in lower case, as the sentence the dialog shows (the request's own error line reads it from the Error's message). */
const reworded = (e: unknown) => (e instanceof Error ? new Error(upperFirst(e.message)) : e);

/** The one dialog that is open, if any. Every dialog is drawn from here, never from inside a table row. */
type Open =
  | { kind: "new-display" }
  | { kind: "playlist"; playlist: PlaylistRow | null }
  | { kind: "rename" | "change-playlist"; screen: DisplayRow }
  | { kind: "revoke" | "delete-display"; screen: DisplayRow }
  | { kind: "delete-playlist"; playlist: PlaylistRow };

function Tile({ icon, title, count }: { icon: IconName; title: string; count: number }) {
  return (
    <div className="tile">
      <div className="muted"><span className="tile-label"><Icon name={icon} /><span>{title}</span></span></div>
      <div className="big">{count}</div>
    </div>
  );
}

const NEEDS_PLAYLIST = "Make a playlist first";

/**
 * Administer > Displays (w28): the screens that show dashboards from a link, and the playlists they show. A summary strip (Active, Revoked, Never connected,
 * Playlists), a "Screens" card and a "Playlists" card, the whole width of the page. "New display" waits for a first playlist (aria-disabled with its reason as a
 * tip, never natively disabled). Revoke, Delete and the playlist delete go through `ConfirmDeleteDialog` with the request inside it, so a refusal stays in the
 * dialog, starting with a capital. The playlist delete keeps its refusal (a screen still shows it: 409 with at most three names) in a slot of its own between
 * the message and the buttons, which for a playlist a screen shows is a fixed five lines high (empty before the answer comes, scrolling when the text is longer),
 * so Cancel and Delete never jump. After a delete took the focused trash button away, the focus goes to the heading.
 */
export function DisplaysPage() {
  const list = useDisplays();
  const site = useSite();
  const revoke = useRevokeDisplay();
  const removeDisplay = useDeleteDisplay();
  const removePlaylist = useDeletePlaylist();
  const toast = useToast();
  const [open, setOpen] = useState<Open | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [landed, setLanded] = useState(0); // counts the deletes; each moves the focus to the heading once the row is gone
  const [refusal, setRefusal] = useState(""); // why the playlist delete was refused, for the slot in its dialog
  const reasonId = useId();
  useEffect(() => {
    if (landed > 0) heading.current?.focus();
  }, [landed]);

  const data = list.data;
  const timezone = site.data?.timezone ?? "UTC";
  const ready = data !== undefined && (site.data !== undefined || site.isError);
  const playlists = data?.playlists ?? [];
  const canMakeDisplay = ready && playlists.length > 0;
  const close = () => {
    setOpen(null);
    setRefusal("");
  };

  const counts = {
    active: data?.displays.filter((d) => d.status === "active").length ?? 0,
    revoked: data?.displays.filter((d) => d.status === "revoked").length ?? 0,
    neverConnected: data?.displays.filter((d) => d.status === "active" && d.last_seen_at === null).length ?? 0,
    playlists: playlists.length,
  };

  const actions = (
    <>
      <button type="button" aria-disabled={ready ? undefined : true} onClick={() => { if (ready) setOpen({ kind: "playlist", playlist: null }); }}>New playlist</button>
      <button
        type="button" className="primary" aria-disabled={canMakeDisplay ? undefined : true}
        aria-describedby={ready && !canMakeDisplay ? reasonId : undefined} title={ready && !canMakeDisplay ? NEEDS_PLAYLIST : undefined}
        onClick={() => { if (canMakeDisplay) setOpen({ kind: "new-display" }); }}
      >
        New display
      </button>
      {ready && !canMakeDisplay && <span id={reasonId} className="sr-only">{NEEDS_PLAYLIST}</span>}
    </>
  );

  let body;
  if (list.error) {
    body = <p className="error" role="alert">Could not load the displays: {list.error.message}</p>;
  } else if (!ready || !data) {
    // The page in its order: the four tiles, then the Screens card (the five columns of the table) and the Playlists card (its four).
    body = (
      <SkeletonRegion label="Loading displays">
        <TilesSkeleton count={4} className="displays-tiles" />
        <div className="page-grid">
          <PageCardSkeleton className="displays-card" purpose><TableSkeleton columns={5} rows={3} /></PageCardSkeleton>
          <PageCardSkeleton className="displays-card" purpose><TableSkeleton columns={4} rows={3} /></PageCardSkeleton>
        </div>
      </SkeletonRegion>
    );
  } else {
    body = (
      <>
        <div className="tiles displays-tiles">
          <Tile icon="screen" title="Active" count={counts.active} />
          <Tile icon="alert" title="Revoked" count={counts.revoked} />
          <Tile icon="clock" title="Never connected" count={counts.neverConnected} />
          <Tile icon="layers" title="Playlists" count={counts.playlists} />
        </div>
        <div className="page-grid">
          <ScreensCard
            screens={data.displays} timezone={timezone}
            onRename={(screen) => setOpen({ kind: "rename", screen })} onChangePlaylist={(screen) => setOpen({ kind: "change-playlist", screen })}
            onRevoke={(screen) => setOpen({ kind: "revoke", screen })} onDelete={(screen) => setOpen({ kind: "delete-display", screen })}
          />
          <PlaylistsCard playlists={data.playlists} onEdit={(playlist) => setOpen({ kind: "playlist", playlist })} onDelete={(playlist) => setOpen({ kind: "delete-playlist", playlist })} />
        </div>
      </>
    );
  }

  return (
    <section className="admin-page displays-page">
      <PageHeader title="Displays" sub="Show dashboards on a wall screen from a link, with no sign-in." actions={actions} headingRef={heading} />
      {body}
      {data && open?.kind === "new-display" && <NewDisplayDialog playlists={data.playlists} onClose={close} />}
      {data && open?.kind === "playlist" && <PlaylistDialog playlist={open.playlist} limits={data.limits} onClose={close} />}
      {data && (open?.kind === "rename" || open?.kind === "change-playlist") && (
        <DisplayFieldDialog display={open.screen} field={open.kind === "rename" ? "name" : "playlist"} playlists={data.playlists} onClose={close} />
      )}
      {open?.kind === "revoke" && (
        <ConfirmDeleteDialog
          title={`Revoke ${open.screen.name}?`} message="The screen stops showing dashboards within a minute." confirmLabel="Revoke"
          onCancel={close}
          onConfirm={async () => {
            await revoke.mutateAsync(open.screen.id).catch((e) => { throw reworded(e); });
            toast.success(`${open.screen.name} revoked`);
            close();
          }}
        />
      )}
      {open?.kind === "delete-display" && (
        <ConfirmDeleteDialog
          title={`Delete display "${open.screen.name}"?`} message="Its link stops working for good. The playlist and its dashboards are not touched." confirmLabel="Delete"
          onCancel={close}
          onConfirm={async () => {
            await removeDisplay.mutateAsync(open.screen.id).catch((e) => { throw reworded(e); });
            toast.success(`Display "${open.screen.name}" deleted`);
            close();
            setLanded((n) => n + 1);
          }}
        />
      )}
      {open?.kind === "delete-playlist" && (
        <ConfirmDeleteDialog
          title={`Delete playlist "${open.playlist.name}"?`} message="The dashboards in it are not touched." confirmLabel="Delete"
          onCancel={close}
          onConfirm={async () => {
            setRefusal("");
            try {
              await removePlaylist.mutateAsync(open.playlist.id);
            } catch (e) {
              setRefusal(playlistDeleteRefusal(e)); // into the slot below, not the dialog's own error line (which would push the buttons down)
              return;
            }
            toast.success(`Playlist "${open.playlist.name}" deleted`);
            close();
            setLanded((n) => n + 1);
          }}
        >
          <p className={`error displays-refusal${open.playlist.display_count > 0 ? " displays-refusal-reserved" : ""}`} role="alert">{refusal}</p>
        </ConfirmDeleteDialog>
      )}
    </section>
  );
}
