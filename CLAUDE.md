# CLAUDE.md

## Project Overview

M8 LPP Emulator module for Schwung. Emulates a Novation Launchpad Pro for use with Dirtywave M8.

## Build Commands

```bash
./scripts/build.sh      # Package files
./scripts/install.sh    # Deploy to Move
```

## Structure

```
src/
  module.json           # Module metadata
  ui.js                 # JavaScript UI (Launchpad Pro emulation)
```

## Features

- Emulates Launchpad Pro MIDI protocol
- Full pad matrix with velocity
- Raw MIDI mode for direct M8 communication
- Song-based knob configuration: an open-ended list of user-named songs,
  each holding pages of individually added, named, CC-mapped knobs. Display
  always shows the active song's current page (Schwung's own knob-page
  visuals, reused directly from `shared/param_pages/`); touching or turning
  a knob swaps its name for its live value, inverted.
- Knobs are added one at a time through a wizard (Shift+touch an empty
  slot) over a catalogue of M8's mixer, send-effect and per-instrument-type
  parameters, which supplies the name, the M8 default value, and the next
  free CC. Pages are created and pruned automatically as knobs need them.
  **M8's MIDI mapping is a LEARN system** — nothing here addresses an M8
  parameter by CC; the user maps each CC on the device (cursor on the
  parameter, hold OPTION, turn the knob).
- **Parameter defaults come from the manual's SCREENSHOTS, not its text** —
  see the memory `m8-manual-images-hold-parameter-defaults` and the "Where
  the default values came from" section of the plan doc before changing
  them.
- Shift+Jog-click opens Song Management (browse/switch/create/rename/delete,
  reusing `shared/menu_layout.mjs`'s list and `shared/text_entry.mjs`'s
  keyboard). See `docs/plans/2026-09-10-song-based-knob-config.md` for the
  full design and status.

## Testing

`tests` live in the session scratchpad rather than the repo so far, but the
pattern is worth keeping: load the REAL `src/ui.js` in Node by rewriting its
`/data/UserData/schwung/shared/` imports to the local `schwung` checkout and
stubbing the device globals (`print`, `fill_rect`, `set_pixel`, `clear_screen`,
`text_width`, `move_midi_*_send`, `host_ensure_dir`, and a `std` shim), then
drive the module through `onMidiMessageInternal` and assert on the draw log.
Two gotchas: `drawMenuList`'s scrollbar needs `set_pixel` stubbed (only
reached once a list is long enough to scroll), and `drawMenuHeader` draws its
title with a pixel font, so a header is invisible to `print`-log assertions —
assert on list contents instead.
