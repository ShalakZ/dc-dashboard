# Display screens

This page is for the administrator who wants a wall screen or a second monitor to show dashboards without anyone signing in. You make a
playlist of dashboards, make a display, copy its secret link, and open the link once on the screen. In this release the screen only
proves that the link works; the rotating wall screen itself comes in the next update (see [What comes next](#what-comes-next)).

## What a display link is

A display link is a web address that works like a key. **Anyone who has the link can see those dashboards without signing in.** It is
shown once, when you make the display: keep it like a password, and send it only to the person who sets up the screen. Links never
expire; one works until you revoke it or delete its display.

A display is not an account and not a role: it cannot sign in, change anything or open any other page. What it may read is under
[What a screen can read](#what-a-screen-can-read). Making playlists and displays needs the permission `displays.manage`, held by the
Admin role only unless you give it to a custom role (see [Roles and permissions](roles-and-permissions.md#the-display-credential)).
The person also needs `dashboards.view`, and `assets.view` when a playlist names a focus asset.

## Make a playlist

Open **Administer > Displays** and choose **New playlist**. Give it a name (1 to 100 characters, not used by another playlist). Choose
**Add a dashboard** for each dashboard to show, and set:

- **Dashboard**: the dashboard to show.
- **Focus** (optional, shown only if you hold `assets.view`): an asset. Widgets that follow the focus show this asset; a widget fixed on
  one asset keeps its own.
- **Seconds on screen**: how long it stays before the next one, 10 to 3600.

**Move up**, **Move down** and **Remove** change the order. A playlist holds up to 20 dashboards; the site holds up to 30 playlists and
50 displays. Saving replaces the whole list, and the last save wins.

## Make a display and copy its link

Choose **New display**, give it a name and a playlist, and choose **Create display**. The next step shows the **Display link** in a field
that cannot be edited. Choose **Copy link**. On a site served over plain http the browser may not allow copying: the button then selects
the text and says "Press Ctrl+C to copy". Then choose **Done**.

The window warns: "Anyone who has this link can see these dashboards without signing in. It is shown only now: copy it before you close
this window." Once it is closed the link cannot be shown again. If you lose it, revoke the display and make a new one.

## Open the link on the screen

Open the link once, on the screen itself. The page moves the secret out of the address at once, so the address then shows `/display`,
and the browser keeps a cookie (for up to 400 days) that only the display pages receive.

- The link stays in the history of any normal browser it was opened in. Open it only on the screen, not on your own computer.
- A kiosk browser that runs in a private session (Microsoft Edge in kiosk mode does) forgets the cookie when it closes. Start it with the
  full link every time.
- The cookie holds the link itself, never expires on its own and goes out with every request the screen makes. On a site served over
  plain http, anyone who can watch the network between the screen and the server can read it from that traffic. Use the HTTPS setup
  (the TLS Caddyfile) for display screens where that matters, and revoke a link you suspect.

## What the page says

The page checks the server every minute and says one of these in large type (it reads "Connecting..." for a moment while it starts):

- "Connected as Hall TV. Playlist Wall A: 3 dashboards (1 skipped). The rotating screen arrives in the next update." (The part in
  brackets is left out when nothing is skipped, and "1 dashboard" is singular.)
- "This screen is not connected. Open its display link once."
- "This display link was revoked or is not valid. Ask an administrator for a new link." It asks again every 5 minutes.
- "Too many wrong links from this address. Try again in about 15 minutes."
- "Cannot reach the server. Trying again..." It waits 5 seconds, then longer each time up to a minute, and never gives up.

## What a screen can read

Only its own playlist, and only through three display routes: opening the link, reading the playlist, and reading the figures of one of
its widgets. That is the playlist's dashboards and their widgets as saved, the figures they show, the names of the focus assets and their
path, the site's time zone, the version and whether data is arriving. A screen cannot sign in, change anything, export CSV, follow the
live stream or open any other page; every other route that needs an account answers 401 to it, and a signed-in account's cookie means
nothing to the display routes. It cannot ask for another range or another asset than the ones saved.

## Revoke and delete

In the row menu of a screen, **Revoke** asks first ("The screen goes blank within a minute."). The server refuses the screen's very next
request; the screen notices within a minute and shows the "revoked" sentence above. The row stays, marked Revoked, and revoking twice
does nothing more. **Delete** removes the record and the link stops for good. A revoked display keeps its name until you delete it, so
another display cannot take that name meanwhile.

A playlist that a display shows cannot be deleted: the answer names the displays ("this playlist is shown by: Hall TV, Wall B"; revoked
ones are marked "(revoked)"). Change their playlist or delete them first.

Deleting a dashboard or an asset never blocks anything. The playlist item is **skipped** and the Displays page says why: "The dashboard
Ops was deleted", "The asset Hall 1 no longer exists" or "This dashboard has no widgets". The name shown is the name at the last playlist
save. A playlist with a skipped item can still be renamed and reordered; choose another dashboard for the item, or remove it.

## Wrong links and the rate limit

Ten wrong links from one address within 15 minutes block that address from opening any link for 15 minutes, and the Audit log gets one
entry ("Too many wrong display links from ..."). Only opening a link counts, so a screen that is already connected keeps working. The
address is the one the server sees; screens behind one shared address share the block, and restarting the `api` service clears it.
A connection is also an Audit log entry (a screen that reloads in a loop adds only a few).

## After a restore

A backup holds the displays as they were. Restoring a backup older than a revocation brings the revoked link back, because the old copy
still says it works. Revoke it again. Displays made after the backup are gone, and their screens show the "revoked" sentence. See
[Backup and restore](backup-and-restore.md).

## Keeping the link out of the logs

The secret sits after the `#` of the link, which a browser never sends to a server. The page sends it once, in the body of a request, never
in an address, so it is not in the server's access log. Only a hash of the secret is stored, and no Audit log entry holds the link.
If you think a link has leaked, revoke the display.

## What comes next

The next update adds the rotating wall screen itself (dashboards in turn at the right size, a notice when data stops arriving, recovery
after a network or power cut) and a start page for the kiosk. Pairing codes and rotating a link without making a new display are not
planned yet.
