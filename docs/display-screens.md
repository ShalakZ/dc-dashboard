# Display screens

This page is for the administrator who wants a wall screen or a second monitor to show dashboards without anyone signing in. You make a
playlist of dashboards, make a display, copy its secret link, and open the link once on the screen. The screen then shows the
dashboards of its playlist one after the other and keeps them up to date. What it shows is under [The wall screen](#the-wall-screen);
how to set up the PC or stick behind it is under [Set up a screen](#set-up-a-screen).

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
50 displays. Saving replaces the whole list, and the last save wins. Cancel or Escape on a playlist with changes that are not saved asks
"Discard your changes?" first; Keep editing goes back to it.

## Make a display and copy its link

Choose **New display**, give it a name and a playlist, and choose **Create display**. The next step shows the **Display link** in a field
that cannot be edited. Choose **Copy link**. On a site served over plain http the browser may not allow copying: the button then selects
the text and says "Press Ctrl+C to copy". Then choose **Done**. Only **Done** closes this step: Escape just moves the focus to Done, and a click
outside the window does nothing, so a stray key cannot lose the link.

The window warns: "Anyone who has this link can see these dashboards without signing in. It is shown only now: copy it before you close
this window." Once it is closed the link cannot be shown again. If you lose it, revoke the display and make a new one.

## Open the link on the screen

Open the link once, on the screen itself. The page moves the secret out of the address at once, so the address then shows `/display`,
and the browser keeps a cookie (for up to 400 days) that only the display pages receive.

- The link stays in the history of any normal browser it was opened in. Open it only on the screen, not on your own computer.
- A kiosk browser that runs in a private session (Microsoft Edge in kiosk mode does) forgets the cookie when it closes. Start it with the
  full link every time (see [Set up a screen](#set-up-a-screen)).
- The cookie holds the link itself, never expires on its own and goes out with every request the screen makes. On a site served over
  plain http, anyone who can watch the network between the screen and the server can copy the link when the screen starts, or its
  cookie at any time, and see the same dashboards until you revoke it. Use the HTTPS setup (the TLS Caddyfile) for screens on a network
  you do not trust.

## What the page says

The page reads the server every minute. Until it has something to show, it says one of these in large type:

- "Connecting..." for a moment while it starts.
- "This screen is not connected. Open its display link once."
- "This display link was revoked or is not valid. Ask an administrator for a new link." It asks again 5 minutes later, then 15 minutes
  after that, then 60 minutes after that (about 80 minutes in all, in case a restored backup brought the link back), and then it stops
  until the page is reloaded.
- "Too many wrong links from this address. Try again in about 15 minutes."
- "Cannot reach the server. Trying again..." It waits 5 seconds, then longer each time up to a minute, and never gives up. Only a screen
  that has not yet reached the server since its page was loaded says this. Once the screen has shown a dashboard, a lost connection
  never replaces it with this sentence (see [The two notices](#the-two-notices)).

When the screen is connected it shows [the wall](#the-wall-screen), or this one sentence when there is nothing to show: "Nothing to
show. Every dashboard in playlist Wall A is skipped or the playlist is empty. An administrator can change it on the Displays page."
(Wall A stands for the name of the playlist.)

## What a screen can read

Only its own playlist, and only through three display routes: opening the link, reading the playlist, and reading the figures of one of
its widgets. That is the playlist's dashboards and their widgets as saved, the figures they show, the names of the focus assets and their
path, the site's time zone, the version and whether data is arriving. A screen cannot sign in, change anything, export CSV, follow the
live stream or open any other page; every other route that needs an account answers 401 to it, and a signed-in account's cookie means
nothing to the display routes. It cannot ask for another range or another asset than the ones saved.

## Revoke and delete

In the row menu of a screen, **Revoke** asks first ("The screen stops showing dashboards within a minute."). The server refuses the screen's very next
request; the screen notices within a minute and shows the "revoked" sentence above. The row stays, marked Revoked, and revoking twice
does nothing more. A screen with a revoked link asks again after 5, 15 and 60 minutes and then stops asking until its page is reloaded. **Delete** removes the record and the link stops for good. A revoked display keeps its name until you delete it, so
another display cannot take that name meanwhile.

A playlist that a display shows cannot be deleted: the answer names the displays ("this playlist is shown by 2 screens: Hall TV, Wall B
(revoked). Change their playlist or delete them first."; with more than three it lists three and "and N more"). Revoked screens are
marked "(revoked)".

A link is not tied to the account that made it. It keeps working when that person leaves or loses a permission, and it shows the
playlist as it is saved now (a focus added later is shown to the link too). When someone who managed displays leaves, revoke the
links they made (the Audit log says who created each display).

Deleting a dashboard or an asset never blocks anything. The playlist item is **skipped** and the Displays page says why: "The dashboard
Ops was deleted", "The asset Hall 1 no longer exists" or "This dashboard has no widgets". The name shown is the name at the last playlist
save. A playlist with a skipped item can still be renamed and reordered; choose another dashboard for the item, or remove it.

## Wrong links and the rate limit

Ten wrong links from one address within 15 minutes make the server refuse further wrong links from that address for 15 minutes, and the
Audit log gets one entry ("Too many wrong display links from ..."). The block never refuses a RIGHT link: a screen with a valid link
connects even from a blocked address, so nobody can keep your screens from reconnecting by sending junk. Only opening a wrong link
counts, a screen that is already connected keeps working, and the link of a display you have revoked is answered like any wrong link but
is not counted (a revoked screen that keeps reloading cannot block its own address). The address is the one the server sees. On
Docker Desktop (the usual Windows install) every browser reaches the server through one gateway, so every screen and every person
shows as the same address: the block then covers the whole site, the Audit log cannot tell machines apart, and the "last connected
from" address of a screen is not evidence of where a link was used. Restarting the `api` service clears a block.
A connection is also an Audit log entry. A screen that reloads in a loop adds a few entries per 5 minutes (the next entry says how many
were left out), and a connection from an address the display has not used before is always written. A screen may also have at most 6
requests running at once (12 for all screens together) and 300 figure requests a minute; beyond that the server answers "busy" and the
screen asks again a moment later.

## After a restore

A backup holds the displays as they were. Restoring a backup older than a revocation brings the revoked link back, because the old copy
still says it works. Revoke it again. Displays made after the backup are gone, and their screens show the "revoked" sentence. A screen
that was revoked for more than about 80 minutes has stopped asking (it asked again after 5, 15 and 60 minutes): after a restore, reload
its page to make it connect again. See [Backup and restore](backup-and-restore.md).

## Keeping the link out of the logs

The secret sits after the `#` of the link, which a browser never sends to a server. The page sends it once, in the body of a request, never
in an address, so it is not in the server's access log. Only a hash of the secret is stored, and no Audit log entry holds the link.
If you think a link has leaked, revoke the display.

## The wall screen

A connected screen draws the dashboards of its playlist the way the app does, on a dark background, with no menus, buttons or scroll
bars. The mouse pointer hides after 3 seconds without a move.

### What is on screen

- One dashboard at a time, in the playlist's order, each for its seconds. Then a short fade to the next one; after the last it starts
  again at the first. With only one dashboard to show, nothing rotates.
- A skipped dashboard (see [Revoke and delete](#revoke-and-delete)) is never shown. If every dashboard is skipped, or the playlist is
  empty, the screen says the "Nothing to show" sentence above.
- The cards are the ones on the dashboard, in the same places and with the same figures. They have no download button, no details and no
  "Split by" choice. The marks of the app stay on the figures: `~` for an estimate, `*` for a partial figure.
- A few seconds before a dashboard's turn the screen fetches its figures, and shows it when they have arrived (after 5 seconds at most),
  so cards do not appear empty. A card that keeps failing never stops the other cards from loading.

### The header

A thin strip along the top, never more than 4.5 percent of the screen's height:

- On the left, the dashboard's name. If the playlist item has a focus asset, its name follows after a comma: "Power, Hall 1".
- In the middle, "2 of 3": the place among the dashboards that are shown (a skipped one is not counted).
- On the right, a short key to the marks that the figures on screen carry, written in short words, two spaces apart: "~ estimated",
  "* partial" and "— no rate" (a dash where a cost has no rate). Only the marks that appear on screen are in it, and the whole key is
  missing when no figure carries one. Then "Updated 14:02" and the clock. In a narrow window or one turned upright, "Updated" goes first
  and then the place ("2 of 3"), so nothing is ever drawn over something else.

"Updated" is the time of the OLDEST figure on screen, not the newest, so one old card cannot hide behind fresh ones. Times are in the
site's time zone and come from the server's clock, not the screen's: a PC with a dead clock battery still shows the right time.

### Edits arrive within about a minute

The screen reads its playlist every minute, so a change you save reaches it within about a minute. If you change the dashboard that is
on screen (add, move or change a card, or choose another focus asset), the screen replaces it with the new version at once, with a
fade. If you delete it, or it becomes skipped, the screen leaves it at once for the next one. Other changes (a new order, other seconds,
a dashboard added or removed) are in place by the time the screen changes dashboard.

### How up to date the figures are

Each card asks the server again every 30 seconds (a card that compares two periods every 60 seconds). The server may answer with a figure
that it worked out up to a minute earlier. So "Updated 14:02" next to a clock that reads 14:04 is normal: **"Updated" can trail the
clock by about two minutes.** A longer gap than that shows one of the notices below.

### The two notices

Each notice is a calm amber strip over the bottom of the screen, with the figures dimmed behind it. Neither blinks, and neither moves the
dashboard. Only one shows at a time, and it goes away by itself on the first answer that says all is well.

- **"Readings stopped arriving at 13:52."** The server says that no recent readings are coming in. It shows one to two minutes after the
  last reading and never because of the screen's own connection. When the age of the last reading is under a minute or unknown, the
  notice has no time. It says "The data collector stopped." instead only when the collector has said so on two reads a minute apart (a
  collector restarts during an update; one read could catch it). One meter that stops alone does not bring this notice: its own card
  shows its stale mark. When nothing has ever been read, there is no notice.
- **"This screen has not been updated since 14:02. Trying again..."** No figure has reached the screen for two minutes. A restart of the
  server that lasts a few seconds, or one failed request, never shows it. The screen keeps trying and shows its last figures dimmed.

A single card whose own figures could not be refreshed for two minutes is dimmed and says "Not updated since 14:02" at the top of the card.
The dimming and that one line are the whole message: the figures stay and no sentence is added under them. A card that has never had its
figures and fails says "This card could not be loaded." and the screen keeps asking for them.
A card the server refuses to give figures for, or one that fails to draw, says "This card cannot be shown."; the other cards go on.
Once a dashboard has been drawn, a lost connection or a restarting server never replaces the whole screen with a sentence (a revoked
link still does).

### Tall dashboards and the size of the text

The screen always shows the whole dashboard without scrolling. It lays the dashboard out at least 1,280 pixels wide, then scales it as
one picture to fit the width and the height of the window; the height left over is shared above and below. So a dashboard with many rows
is shown smaller. **Nine rows or fewer read best from across a room** (the Power template has 8 rows, the Cost template 12). A taller
one is still shown whole.

The text is sized for someone about 3 metres away. A 55-inch TV is about 685 mm tall, so one pixel of a 1,080-row picture is about
0.63 mm. The screen makes every text at least **24 pixels for each 1,080 rows of the window**: capital letters about 11 mm tall on a
55-inch TV (13 mm on a 65-inch), enough to glance at a label from 3 metres. The header, the notices and the figures get at least
**32 pixels** for each 1,080 rows, capitals about 14 mm, which is the size usual guidance gives for text that must be read at that
distance. That holds for the header, the notices and the big figure of a stat. The values of a table and the
comparison figure of a stat aim at 32 as well, but a table row has room for 24 pixels of the dashboard's own size at most, so they
reach the full 32 only when the dashboard is scaled up by a third or more, and measure between 24 and 32 when it is shown at its own
size or larger. A 4K window is twice as many pixels tall, so the same limits are twice as many pixels, and the picture looks the same.
A TV at 3840 x 2160 with Windows scaling at 200 percent counts as 1920 x 1080 to the page and looks the same too.

There are two exceptions to the limits above:

- The small numbers and dates around a chart (the axis labels). They only follow the scaling, so on the Power template at 1,080 rows
  they are about 17 pixels tall, below the 24, and smaller still on a chart with many bars or points.
- A dashboard taller than about nine rows. It is shown smaller than its own size to fit, so all its text is smaller too: on the Cost
  template (12 rows) the text measures about 18 pixels for each 1,080 rows instead of 24, and its figures can be well under 32.

Read the figures, not the axes, from across a room, and keep a wall dashboard to nine rows or fewer.

### Updates, sleep and wake

- After you update the server, the screen sees the new version on its next read (within a minute). It then waits a random 10 to 30
  seconds, so that ten screens do not reload together, and reloads itself at the next change of dashboard (with one dashboard, when its
  time is up). It reloads at most once every 10 seconds, and not at all when the browser blocks site storage; then press F5 or restart
  the browser.
- After the PC wakes from sleep, or the network comes back after a cut, the screen reads at once instead of waiting for its next turn.
- When the server restarts, or the network is cut, the screen keeps its last figures on screen and asks again.

### What a screen costs the server

Measured on a test site with a playlist of three dashboards of about four figure cards each, 20 seconds each. One real screen, watched
for an hour, made about one playlist read and about 11 figure requests a minute. A typical answer takes the server about 10
milliseconds. The processor use of the `api` service (one worker is 100 percent) was 1.9 percent on average with no screen and 1.9
percent with one screen: a screen adds nothing you can measure. With ten screens at once it was 4.9 percent on average over 5
minutes, with one short peak of 36.8 percent while the ten screens were connecting. That test used simulated screens that asked for
about 8 figures a minute each (together about 10 playlist reads and 80 figure requests a minute); ten real screens would ask for about a
third more, about 110 a minute. The server never answered "busy" to
a playlist read or a figure request. A screen asks for at most 2 figures at a time, and when the server does say "busy" it waits the
time the server names plus a little random delay, so screens do not all come back at the same moment after a restart.

The server takes only 3 screens connecting at the same instant (after a power cut, say); the others try again by themselves a few
seconds later. The other limits are in [Wrong links and the rate limit](#wrong-links-and-the-rate-limit).

Pairing codes (a screen that never holds the link), rotating a link without making a new display, a separate token for each screen and
a light-coloured wall are not planned yet.

## Set up a screen

Use a small PC or a stick that runs a current **Chrome or Edge** (version 111 or newer, released in 2023). A TV's own browser is not
tested and may lack features the pages use. The steps below were not tried on a TV.

Copy the link whole, `#` and everything after it, from the Display link window. `<server>` and `<secret>` below stand for the two parts
of that link.

### Edge on Windows

```
msedge.exe --kiosk "http://<server>/display#<secret>" --edge-kiosk-type=fullscreen --no-first-run
```

Edge's kiosk mode runs a private (InPrivate) session, so Edge forgets the cookie whenever it closes. The start command therefore holds
the WHOLE link, `#` included, and each start connects again. Lock the PC's Windows account, and treat the shortcut (or the kiosk
settings) that holds the link as secret as the link itself.

To start it by itself:

- **Windows "Set up a kiosk" (Assigned Access).** Open Settings, search for "kiosk", choose **Set up a kiosk**, pick **Microsoft Edge**
  and **Digital/Interactive signage**, and type the whole link as the web address. It starts Edge again if it closes. The page also asks
  for an idle time and suggests 5 minutes. Nobody touches a wall screen, so after 5 minutes Edge would close and start again, and the
  page would reload every time: enter the longest time the page accepts.
- **Or a shortcut in the Startup folder.** Press Windows+R, type `shell:startup`, and put a shortcut to Edge there with the command
  above as its target. It starts Edge when the account signs in, but does not start it again if Edge closes.

Started from the command line in full-screen mode, kiosk mode has no idle timeout. Do not add `--kiosk-idle-timeout-minutes`: Microsoft
says that option closes Edge when the time is up and does not start it again; only Assigned Access does.

Either way, the PC has to sign in to that account by itself after a power cut. Set that up in Windows.

### Chrome on Windows or Linux

```
chrome --kiosk --no-first-run "http://<server>/display#<secret>"
```

On Windows the program is `chrome.exe`; on Linux it is `google-chrome` or `chromium`. A normal Chrome profile keeps the cookie. Each
start still opens the link and connects again, which is fine. Microsoft says Edge kiosk mode "for Linux is not supported", so use Chrome
or Chromium there.

### Linux: start it at login

Set the desktop to sign in by itself, then use an autostart file, `~/.config/autostart/display.desktop`:

```
[Desktop Entry]
Type=Application
Name=Dashboard wall screen
Exec=chromium --kiosk --no-first-run "http://<server>/display#<secret>"
```

Keep the link in double quotes; the `#` is safe inside them. As an alternative that also restarts the browser when it closes, a systemd
user unit, `~/.config/systemd/user/display.service`:

```
[Unit]
Description=Dashboard wall screen
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=/usr/bin/chromium --kiosk --no-first-run "http://<server>/display#<secret>"
Restart=always
RestartSec=10

[Install]
WantedBy=graphical-session.target
```

Then run `systemctl --user daemon-reload` and `systemctl --user enable --now display.service`. The unit works only if your desktop gives
the user's systemd the display variables (many do); if Chromium says it cannot open a display, use the autostart file instead. Neither
file was tried on a TV.

### Scale, sleep and the screen saver

- **Scale.** Leave the browser at 100 percent. The page scales itself; zooming the browser only makes the page think the window is smaller.
- **Sleep and screen saver.** Switch both off in the operating system. The page asks the browser to keep the screen awake, but a
  browser allows that only on a secure site (HTTPS, or localhost). On plain http, switching sleep off in the operating system is the
  only protection.

### Is the screen alive?

On the Displays page, the **Last connected** column of the screen. A time under about 2 minutes ("1 min ago") means yes: the screen
reads its playlist every minute while its page is open, and the Displays page re-reads the list every minute while you look at it.
