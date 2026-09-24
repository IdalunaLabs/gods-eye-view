# Time travel

Flights and vessels can replay the recent polls this browser has already
accepted. The picture is historical. It is labelled **REPLAY** on the clock,
on a badge beside the HUD, and on the Flights and Live Vessels chips until
**LIVE** is pressed.

## What is stored

Each accepted poll becomes one snapshot for that layer:

- time
- interned contact ids
- latitude, longitude, altitude, heading, and speed in typed arrays
- callsign, name, and type kept once per id, not copied into every snapshot

Sampling between two snapshots interpolates contacts that appear in both.
Latitude and altitude are linear. Longitude and heading take the short arc,
including across the antimeridian. A contact present on only one side of the
bracket is held at that fix and marked `held`. It is not extrapolated. A
contact missing from the sample is hidden. A tracked flight keeps following
its historical position; returning to LIVE re-attaches through the existing
~0.9 s flight-tracking smoothing.

Capture is queued off the render path after the reconciled snapshot exists.
Live rendering is unchanged while the clock is LIVE.

## Caps

| Cap | Default | Notes |
| --- | --- | --- |
| Memory | 200 MB | Shared by flights and vessels. Oldest snapshots leave first. |
| Time | 60 min | Measured from the newest stored sample back. Cannot be set above 24 h. |
| Snapshots | 4096 per layer | Oldest snapshots leave first. |

The first visit starts empty. There is no server history. IndexedDB, when the
browser provides it, writes the buffer behind the poll and restores it on a
later load if the in-memory buffer is still empty. Replay state itself is not
written into share links.

## Controls

The bar sits above the command dock.

- **LIVE** returns to the live feeds.
- **PLAY / PAUSE** plays the buffered range from the start, or resumes a paused cursor. Playback pauses at the newest sample.
- **Speed** is 1×, 4×, or 16×.
- The scrubber covers the buffered extent. The readout is the offset from the newest sample, `-MM:SS`.

Keyboard, when a text field is not focused:

- `[` / `]` step 10 seconds.
- `Shift+L` returns to LIVE.

While playback is running, the render governor keeps a `history-replay` hold so the globe keeps moving.

## Limitations

- Only flights and civil vessels are replayed. Satellites, traffic, cameras, and the other layers stay on their live clocks.
- Military flights are not part of this buffer.
- The buffer is this browser's recent polls, not an archive.
- A reload before the first successful poll still has nothing to restore.
- Share links do not restore the replay cursor.
