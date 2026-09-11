# Song-based knob configuration — design plan

Replaces the fixed 9-save-slot / 9-bank knob system (`banksDef`, `saveBanks`,
`knobconfig.json`, `changeBank`/`changeSave`) with an open-ended list of
user-named **songs**, each holding its own set of **pages** of 8 named,
CC-mapped knobs, rendered using Schwung's own knob-page visuals and gesture
set rather than the module's current 4-line text status.

## Status

Implemented so far, built alongside the old bank system (not yet deleted),
device unreachable for hardware verification while this was written —
`renderPage`'s exact call was verified against the real library in a Node
harness (correct data shape, stays in screen bounds, prints the right
labels), but nothing below has been exercised on real hardware yet:

- **Phase 1 (data model + persistence)** — done. `Song`/page/knob structures,
  `songs.json` load/save, wired into `markM8Connected()`.
- **Phase 2 (rendering)** — done, with a twist versus the original phase
  list: rather than a separate validation step against a hardcoded song, it's
  wired directly into `drawUI()` against the real active song, replacing the
  text status whenever connected. Wrapped in try/catch with a fallback to the
  old text status — an exception in `tick()`'s draw path is fatal to the
  whole module otherwise, same lesson as the `saveConfig()` crash earlier.
- **Phase 3 (jog-turn page scrolling)** — done. `MoveMainKnob`/CC14.
- **Phase 4, partial** — knob turns (CC71-78) now edit the active page's
  values directly and forward to M8 on `knob.cc`, redirected away from the
  old bank system for just those 8 CCs (CC79/master still runs the old path
  unchanged). Autosave added, throttled to once per
  `SONGS_AUTOSAVE_INTERVAL_MS` (2s) while dirty, plus `globalThis.onUnload()`
  to force a flush on exit regardless of the throttle.
  **Deliberately NOT done in this pass**: the full `page_controller.mjs`
  adoption (hold-to-reveal, Shift precision, Mute+touch reset) you'd chosen
  earlier. `createController`'s `io` contract carries chain-slot concepts
  (`slot`, `component`, child-level/voice tracking) that don't map cleanly
  onto this flat data model, and integrating it correctly needs either a much
  deeper read than was practical blind or a hardware pass to verify against —
  wiring it in without either felt like the wrong tradeoff versus a plain,
  well-understood direct-edit path (±1 per detent, matching the old system's
  step size). Coarse/fine step and rename-via-Shift are also deferred with
  it.
- **Phases 1-4 confirmed working on real hardware** after the above was
  written — `songs.json` round-trips correctly, knob edits reach M8 and
  persist (verified directly: read the file off the device mid-session and
  saw the actual dialed-in values).
- **Phase 5 (Song Management screen)** — implemented, reusing two more
  existing Schwung components rather than building from scratch:
  `drawMenuList` (`shared/menu_layout.mjs`) for the song list, and the full
  `shared/text_entry.mjs` pad-typing keyboard for rename/create-naming. Both
  verified in the same Node-harness style as `renderPage` before deploying
  (real imports, stubbed device globals, checked nothing throws or draws
  outside the screen). Entry: Shift+Jog-click. While open: jog turn moves the
  list cursor, jog click selects (switches active song, closes), Back closes
  without switching, Capture creates a new song (and immediately opens
  rename), Menu renames the highlighted song, Shift+Delete removes it (blocked
  if it's the last song). LPP pad/button forwarding is suspended for the
  duration — `onMidiMessageInternal` is dispatched elsewhere entirely while
  this screen is open, and `onMidiMessageExternal` keeps tracking M8's LED
  state in the cache without painting it, so `queuePadRedraw()` on close
  catches the pads up to whatever M8's actually been showing. `songs.json`
  now also stores `activeSongId` (was array-only before; the loader still
  reads the old bare-array format so the device's existing file isn't lost).
  **Confirmed working on hardware** ("Looking good").
- **Phase 6 (cutover)** — done. Deleted `banksDef`, `saveBanks`,
  `currentSave`/`currentBank`, `updateConfig`, `clamp`, `loadConfig`/
  `saveConfig` (old `knobconfig.json`), `getColorForKnobValue`, `setKnobLed`,
  `changeSave`, `changeBank`, `handleMoveKnobs`, `movePadToKnobBankMap`, and
  the now-orphaned `MidiNoteOn`/`MidiCC`/`Trans24th`/`Pulse4th` imports —
  ~370 lines net. `MODULE_DIR` survived (shared with `SONGS_PATH`). The odd
  step notes (17-31, formerly bank/save-slot select) and knob-touch notes
  (0-8) are now simply unclaimed - they were never part of the LPP grid
  either. **CC79 (master)'s role, previously an open question**: resolved as
  a simple song-independent pass-through - turning it forwards its own value
  straight to M8 on CC79, no display representation, no per-song data. Kept
  deliberately minimal rather than inventing a dedicated feature for it.
  `help.json` and this module's `CLAUDE.md` updated to describe the new
  system instead of the deleted one. Deployed; existing `songs.json` on the
  device (both test songs, including mid-session edits) survived the
  format upgrade intact.

All six phases are now complete and deployed.

### Post-launch: three rounds of gaps/enhancements found in use

**Round 1:**

- **New pages collided with earlier ones' CCs.** "Add a page" (Shift+jog-turn
  CW) always built the new page from `71-78`, same as every other page, so a
  second page's knobs silently controlled the same M8 parameters as the
  first instead of new ones. Fixed with `nextPageCcStart()`: cycles through
  the same curated CC ranges the old bank system used (`71, 14, 23, 35, 44,
  53, 102, 111` — already proven not to overlap each other or the 120-127
  reserved range) and falls back to scanning for a free 8-CC block past that.
- **No way to rename a knob or change its CC at all.** Phase 4 explicitly
  deferred this (`handleSongKnobTurn`'s `shiftHeld` branch was a no-op).
  Added a **Knob Edit** screen: Shift+touch a knob (notes 0-7) opens it, jog
  turn changes the CC (1-127), Menu opens `text_entry.mjs` to rename it
  (same component Song Management's rename already uses), Back closes. Same
  screen-ownership shape as Song Management — suspends LPP forwarding,
  resyncs the pads via `queuePadRedraw()` on close.

**Round 2: "use the built-in Schwung menus wherever menus are used," plus two
new per-knob settings.**

- **New per-knob settings.** Each knob now carries `mode` (Absolute/Relative,
  default Absolute) and `display` (0-127/Hex, default decimal). `mode`
  changes what `handleSongKnobTurn` forwards to M8: Absolute sends the
  knob's own accumulated 0-127 value as before; Relative instead forwards
  the raw incoming relative-encoder byte untouched (`data[2]`, still
  `decodeDelta`-encoded 1-63 CW / 65-127 CCW), for M8 destinations that
  expect relative CC deltas rather than an absolute position. `display`
  only affects the on-screen rendering of the knob's value on the main song
  page, not what's sent.
- **Knob Edit rebuilt on `param_pages` instead of hand-rolled `print()`.**
  Renamed in-code to "Knob Settings" (`buildKnobSettingsMetaIndex`,
  `drawKnobEdit`, still Shift+touch a knob to open). It's now a real 4-field
  `chain_params` page rendered through the same `renderPage`/`buildMetaIndex`
  the main song page uses: `Name` (opaque `"string"` field — no turn
  behaviour, touch-to-dive only, matching "a knob that can't turn opens on
  touch" elsewhere in Schwung), `CC` (`"int"`, 1-127), `Mode` and `Display`
  (`"enum"`, backed by `KNOB_MODE_OPTIONS`/`KNOB_DISPLAY_OPTIONS`). Gesture
  mapping onto the 4 physical knobs: knob 1 touch → opens `text_entry.mjs`
  rename (replaces the old dedicated Menu-button rename gesture, since the
  field itself is now touch-to-edit like the rest of the page); knobs 2-4
  turn → CC / Mode / Display respectively. Back still closes. Verified via a
  Node harness importing the real `param_meta.mjs`/`render_page.mjs` before
  deploying — caught that `chain_params`' display label field is spelled
  `name`, not `label` (confirmed by reading `param_meta.mjs`'s `normalize()`
  directly), which would otherwise have silently rendered blank labels.
- **Hex display with no native library support.** `param_format.mjs` has no
  declarative hex option — `display_format` only understands `.Nf`/`.N%`,
  and the one `formatValue` io-hook that could support it lives on the
  unused `page_controller.mjs` LAYOUT_MOVY path, not the dial/bar renderer
  this module actually calls. Rather than patch the shared library (out of
  scope for a single module), worked around it with a 128-option `"enum"`
  field whose `options[]` are precomputed two-digit uppercase hex strings
  (`i.toString(16).toUpperCase().padStart(2, "0")`) — the enum's selected
  *index* doubles as the knob's real 0-127 value, so no separate value
  translation is needed anywhere else. Verified in a Node harness that value
  92 renders as "5C".
- **Song Management's chrome upgraded to match.** Its header/footer, previously
  hand-rolled with `print()`/`fill_rect()`, now use `drawMenuHeader("Songs")`
  and `drawMenuFooter([...])` from `shared/menu_layout.mjs`, bracketing the
  existing `drawMenuList` call. List behaviour, rename/create/delete gestures
  unchanged.

  `help.json` updated: "Knob Edit" renamed to "Knob Settings" with the new
  4-field gesture mapping; "Knobs & Songs" updated to mention Knob Settings'
  mode/display fields instead of the old generic "open Knob Edit for it."
  Deployed and syntax/build-verified. **The `renderPage`-based Knob Settings
  screen described in this bullet was superseded in Round 3, immediately
  below, before ever being confirmed on hardware** — its data model (mode,
  display, cc, name per knob) is unchanged, only the widget it's drawn with.

**Round 3: "use the same drawMenu as the song management," plus an Add Song
row.**

- **Knob Settings rebuilt again, this time on `drawMenuList`.** Round 2's
  synthetic `chain_params`/`renderPage` page is gone — Knob Settings now uses
  the exact same `drawMenuHeader`/`drawMenuList`/`drawMenuFooter` triple as
  Song Management, so every settings-style screen in the module now shares one
  look. The four fields (Name/CC/Mode/Display) are rows in a plain list
  (`items: KNOB_SETTINGS_FIELDS`, a raw string array — `getLabel`/`getValue`
  closures do the lookup into the knob object, same shape as Song Management's
  `getLabel`/`getValue` over song objects). Interaction: jog wheel moves the
  row cursor; jog click on Name dives straight into `text_entry.mjs` (unchanged
  from Round 2 — an opaque field never turns); jog click on CC/Mode/Display
  toggles that row "entered", using `drawMenuList`'s own `editMode` flag (its
  documented job in the host codebase: bracket the selected row's value as
  `[value]` — borrowed rather than invented, per `page_controller.mjs`'s
  `drawPageChromeList` comment on the same flag). While entered, jog turn steps
  that field's value (CC 1-127, or the Mode/Display enum index); jog click
  again un-enters back to row navigation. This dropped the old
  knob-per-field mapping (knobs 1-4 = Name/CC/Mode/Display) entirely — every
  control is now jog wheel + jog click, identical to Song Management. `Back`
  closes unconditionally, matching Song Management's footer contract exactly
  ("Back: Close") rather than the two-stage exit-editing-first version
  considered and rejected for consistency. Verified via a Node harness
  (`test_knobedit_list.mjs`) rendering all 4 rows × entered/not-entered before
  deploying.
- **Song Management gained a first row, "+ Add Song."** Previously the only way
  to create a song was the Capture-button shortcut (kept, unchanged, still
  works from anywhere in the screen); now row 0 of the list is a synthetic
  `ADD_SONG_ITEM` (not a real song), and jog-clicking it calls the same
  `createSong()` Capture already called. Every other row shifted down by one —
  `songMgmtCursor` is now an index into `[ADD_SONG_ITEM, ...songs]`, so
  `openSongManagement`/`createSong`/`deleteSong`/rename/select all had their
  index math adjusted by the +1 offset (`songs[cursor - 1]` everywhere a real
  song is meant). `help.json`'s Song Management section documents the new row.

  `help.json` updated for both. Deployed; **not yet confirmed on hardware** —
  next time at the device, check: jog-click entering/exiting a Knob Settings
  row (especially that a second click un-enters rather than re-entering
  something else), the bracket `[value]` rendering while entered, jog-click on
  the Add Song row actually creating and opening rename, and that the cursor
  math after a delete near the list boundary doesn't land somewhere odd.

**Round 4: hardware-reported hex-display bug, plus a Knob Settings navigation
gap.**

- **Hex display was one octave off M8's own scale.** `HEX_OPTIONS` mapped a
  CC's raw 0-127 straight to hex (`i.toString(16)`), but M8 parameters are a
  byte (00-FF) and M8 doubles an incoming 7-bit CC to reach its native range
  — reported from hardware as "the M8 hex goes to FF, so each value +/- is
  2." Fixed by doubling before formatting (`(i * 2).toString(16)...`), so the
  option list now runs 00, 02, 04, ... FE — matching M8's own doubling
  one-for-one, though a 7-bit CC can still only ever reach FE, one short of
  M8's true top value FF. Only the display changed; the wire value sent to
  M8 is still the plain 0-127 CC, unaffected.
- **Touching another knob while Knob Settings was open did nothing.** The
  screen only handled `0xb0` (CC) messages, so a knob touch (notes 0-7) fell
  through to a silent early return — the only way to switch which knob you
  were editing was Back, then Shift+touch the other one. Now a touch on a
  different knob (0-7) while the screen is open jumps straight to editing
  that knob, resetting the row cursor to Name and dropping out of "entered"
  — the same state a fresh Shift+touch open lands in. Shift is not required
  for this switch (only for the original open), since the screen already
  owns every knob touch while it's up and there's no other gesture a plain
  touch could mean there.

  Both deployed; **not yet confirmed on hardware.**

**Round 5: the main song page's dial and value display, both reported from
hardware after using Round 4's fix.**

- **Hex-display knobs had no dial.** `render_page.mjs`'s `drawCell` only draws
  the dial/pointer widget for a `KIND_NUMBER` cell — `KIND_ENUM` (what the
  Round 2/3 hex trick declared for a Hex-display knob) draws a boxed value
  instead, no dial. So a knob's needle disappeared the moment its Display was
  set to Hex, while a Decimal-display neighbour kept its dial — reported as
  "can the knob animation also be displayed." Every knob's `chain_params` now
  declares plain `type: "int"` unconditionally (the enum-of-hex-strings trick
  and `HEX_OPTIONS` are gone) — the dial's pointer fraction comes from the
  same 0-127 raw CC value either way, so it's correct in both display modes,
  and the fix is one branch deleted, not one added.
- **Per-cell text is now name-only; the value lives in the title row
  instead.** Losing the enum trick also means `formatParamValue` — the only
  thing that ever put text in a dial cell's body — can't emit hex, so cell
  text is never the value now, only the knob's `label` (name), same as before
  Round 2. To still show a value on request ("the display of values only
  happen on a knob when the knob is touched or moved, and replace the name
  with the value. Once released, go back to the name") without touching
  `render_page.mjs`: `drawSongPage` swaps what it passes as `title` (normally
  the song name, printed top-left by the header) for `"<knob name>: <value>"`
  whenever a knob reads as active, computed by a formatter we own
  (`formatKnobReadoutValue`, reusing the Round 4 doubling for Hex).
  Deliberately NOT `renderPage`'s own `touched` param and its built-in
  `drawTouchStrip` header-swap, even though that does almost exactly this
  natively — `drawTouchStrip` formats through the same hex-blind
  `formatParamValue`, so passing `touched` would paint a decimal readout over
  a Hex knob's own title, silently wrong. The trade is losing
  `drawTouchStrip`'s per-cell underline decoration (nothing else marks WHICH
  cell is active); accepted rather than forking the library over one
  decoration.
- **"Touched OR MOVED"**: a capacitive touch (notes 0-7) claims the readout
  until release (`claimKnobTouch`/`releaseKnobTouch`); a turn with no touch
  registered (`handleSongKnobTurn`, unshifted) claims it for
  `KNOB_TURN_CLAIM_MS` (1200ms) instead, via `claimKnobTurn` — copying the
  shape of `page_controller.mjs`'s own `TURN_CLAIM_MS`: a turn has no release
  event of its own (a knob can be moved without its capacitive pad ever
  registering), so a time-limited claim is the only way to let go of it.
  `isKnobReadoutActive` recomputes from scratch on every draw (touched-flag
  OR turn-deadline-not-passed) rather than something a tick handler mutates,
  so there is no separate expiry path to get out of sync with the draw.

  Deployed; **not yet confirmed on hardware.**

**Round 6: correction to Round 5 - the value belongs on the knob's own
label, not the page title.** ("You misunderstood. The value should replace
the name of the knob, below the knob animation, not at the top.")

- **Why the title-row approach was wrong**: Round 5 swapped the whole page
  title (song name, top-left) for `"<knob name>: <value>"` while a knob was
  active, reusing `renderPage`'s existing title slot to sidestep needing the
  exact pixel position of an individual cell's own label. That was legible
  and easy, but it isn't where the actual knob is on screen — with 8 dials
  visible, a readout at the top doesn't say which one it describes without
  reading the name in it, and it isn't "below the knob" as asked.
- **What replaced it**: the active knob's own NAME LABEL — the line of text
  render_page.mjs's dial widget prints just below the dial circle — is now
  overwritten in place with its VALUE, reverting to the name once the knob
  reads inactive again (same `isKnobReadoutActive` gate as Round 5, unchanged).
  The page title is back to always being the song name.
- **How, without forking render_page.mjs**: that exact pixel position isn't
  exported — `HEADER_BLOCK`, `FONT_H` and the dial radius that `geometry()`
  derives it from are all private to that file, so hardcoding them here would
  silently drift the next time that file's internals change (the library's
  own docs warn against exactly this: "imported rather than restated ... a
  second copy is how things come to stop agreeing"). Instead, `drawSongPage`
  wraps `print` for the one `renderPage` call and records where every label
  actually landed — self-calibrating against whatever the real geometry is,
  every frame, rather than assuming it. The label print is reliably the LAST
  8 `print()` calls renderPage makes for an always-exactly-8-knob page (0-2
  header prints first, then one per cell in slot order); verified against the
  real library in a Node harness (`test_label_overlay.mjs`) across several
  knob indices, including a name long enough to get abbreviated
  ("RESONANCE" → "RESONNC"), before relying on it. The recorded print's `x`
  plus its OWN text's measured width recovers the cell's true horizontal
  centre, so the replacement value - almost always a different width than the
  name it's replacing - still centres correctly, using the exported
  `centeredText` helper rather than reimplementing centring by hand. A small
  fixed-size rect (32×8, matching the footprint `drawCell`'s own "locked"
  background uses for the same line of text) covers the old label first.
- **The value reads INVERTED** - a solid fill (color 1) with the text cut
  into it in the background colour (0), asked for as "black text on white
  background". It first shipped as plain text over a blanked rect, which
  read as just another label. The inverted form is not a new idiom: it is
  exactly what `drawCell`'s `labelBg`/`labelFg` pair does for a locked row,
  i.e. the shared library's existing way of saying "this line of text means
  something other than the name you normally see here" - the same sentence
  this readout is making.

  Deployed; **not yet confirmed on hardware.**

**Round 7: knobs become individual, added through a wizard over an M8
parameter catalogue.**

The page-of-8 was the unit of everything until now: a page was created with
8 knobs, deleted as 8, and given a block of 8 consecutive CCs. Knobs are the
unit now, and pages are just where they sit.

- **Slots, not a list.** `page.knobs` is still length 8 but now holds
  `null` for an empty slot. A knob keeps the physical encoder it was added
  to; removing one leaves a hole rather than sliding its neighbours under
  the user's fingers. `renderPage` already draws a faint tick for a slot
  whose key is falsy (`drawEmptyCell`), so a hole needed no rendering work
  and reads as "available" for free. Songs saved before this are 8 filled
  slots — a full page — so nothing needed migrating; the device's existing
  `songs.json` (two songs, some knobs predating even the mode/display
  fields) loads untouched, missing fields degrading to Absolute/decimal.
- **Pages follow knobs.** `nextFreeKnobSlot` appends a page when every slot
  is taken; `removeKnobAt` drops trailing empty pages again, and only
  trailing ones — deleting from the middle would renumber every page after
  it, moving pages the jog scrolls by. The Shift+jog add/delete-page
  gesture is therefore gone, and `PAGE_CC_STARTS`/`nextPageCcStart` with
  it: CCs are now allocated one at a time by `nextFreeCc`, the lowest free
  in 1-119 across the whole song (0 is Bank Select MSB, 120-127 reserved).
- **The wizard** (`Shift`+touch an empty slot) is three `drawMenuList`
  steps: group, parameter, and — only where the parameter addresses one of
  several identical things — a track (1-8) or instrument (00-7F). The
  right-hand column previews the name the knob will get, so the result is
  visible before committing. Back steps up one level, and out from the
  first. Committing sets name, `nextFreeCc`, the catalogue default, Hex and
  Absolute.
- **`Add Knob` is on Knob Settings too, and that is not redundant.** A FULL
  page has no empty slot left to Shift+touch, which is exactly the case
  auto-page-creation exists for — without a second door it would be
  unreachable. `Remove Knob` sits beside it. Both are ACTION rows: they
  fire on click and never enter `editMode` the way the value rows do.
- **The catalogue** covers the Mixer, all three send effects, and all seven
  instrument types, each type's own parameters plus the common set every
  type carries. Name stems are M8's own FX command mnemonics where the
  manual publishes them (`VT3`, `VMV`, `XRS`, `XDF`), which makes a knob
  and the tracker's FX column call one thing by one name. The manual does
  NOT publish mnemonics for type-specific parameters ("check the FX command
  help view with the desired instrument in use"), so those use the
  parameter name as it appears on M8's instrument screen instead of an
  invented mnemonic that might not match the device.
- **`VOL`, `PIT` and `FIN` are deliberately absent.** They are documented
  FX commands, but they OFFSET a playing note rather than naming a row the
  cursor can rest on — and M8 only maps a CC to a parameter the cursor can
  reach, so offering them would offer knobs that cannot be learned onto
  anything. An instrument's real level controls are `AMP` and `DRY`.

### Where the default values came from, and the trap in finding them

The manual's prose does not tabulate defaults — on the device
`[EDIT]+[OPTION]` resets a parameter to its default, but the values are
never printed. **They are visible in the Instrument View page's SCREENSHOT**,
which is an image, so a text search of the PDF finds nothing. A first pass of
this catalogue was built from the prose alone and was wrong in two ways that
only the image showed: it put `DRY` at `0xE0` (it is `0xC0`), and it
**omitted `PAN` entirely** — grepping the extracted text for "pan" matches
only "spanning" and "expanded", so the parameter looked like it did not
exist. It does; it is centred at `0x80`, which was the example given when
per-parameter defaults were first asked for.

So: the common instrument defaults (`FLT 00`, `CUT FF`, `RES 00`, `AMP 00`,
`LIM 00`, `PAN 80`, `DRY C0`, `MFX/DEL/REV 00`) and Wavsynth's `SIZE 20` are
read off that screenshot. Elsewhere the values follow conventions the manual
states in words — `0x80` centre for DJ filter ("a value of 80 is off with no
filtering"), Sampler `DETUNE` ("80 being the center frequency") and
Hypersynth `SUBOSC`; `0xFF` for stereo width ("00 is mono, FF is stereo") —
plus track volume `0xE0` confirmed from hardware. Modulation-page rows are
not in the screenshot and start inert (zero amount), which is the safe thing
to hand a knob whatever the modulator's shape.

**When a value is not in the text, look at the pictures before concluding the
feature does not exist.**

### Testing

`test_wizard.mjs` loads the REAL `src/ui.js` in Node — rewriting its
`/data/UserData/schwung/shared/` imports to the checkout and stubbing the
device globals — and drives it entirely through `onMidiMessageInternal`,
asserting on the draw log and the MIDI actually sent. 34 checks over the
whole flow: wizard navigation and Back, name generation with and without a
number, CC allocation, the catalogue default reaching the wire, page
auto-create and prune, and that removing a knob leaves its neighbours in
place. This is a better harness than the per-feature scratch scripts used in
earlier rounds and is worth reusing.

Two things it caught that reading could not: `drawMenuList`'s scrollbar calls
`set_pixel`, which earlier scratch harnesses never stubbed because the lists
they drew were short enough not to scroll; and `drawMenuHeader` renders its
title through a pixel font (`font4x5`), not `print`, so a header is invisible
to a print-log assertion — tests must assert on list CONTENT, not on the
header.

  Deployed; **not yet confirmed on hardware.**

**Round 8: the wizard restructured around the instrument, mod slots, and
multi-knob graphics.**

Round 7's wizard was one flat list of groups where an instrument type WAS a
group, so the instrument number was asked last (as a 128-row list) and the
four mod slots had nowhere to live at all — the catalogue had a fixed
"Env1/Env2/LFO1/LFO2" set, which is wrong: **M8's 4 mod slots are each
assignable to any of six types** (AHD / ADSR / Drum envelope / LFO / Trig
envelope / Tracking), so what a slot's parameters even ARE depends on a
choice the wizard never offered.

- **The root is now Instrument / Mixer / Sends / Other.** Sends split out
  into its own level (ModFX, Delay, Reverb), and **Other** just opens the
  keyboard and uses what you type — for an M8 parameter this catalogue does
  not know, or a mapping to something else entirely.
- **Instrument asks for the number FIRST**, as two hex digits edited
  separately in the Knob Settings idiom (jog moves, click enters/leaves a
  digit, an accept row commits). Each digit clamps to 0-F on its own and
  never carries into the other — winding a low digit past F to reach the
  next sixteen is exactly the scroll this replaced. Then: **Generic**
  (amp/pan/dry/sends/filter), **Mods** (slot 1-4, then type, then that
  type's parameters), or **Instrument Type** (only what that type has).
- **The wizard is a STACK of frames now, not numbered steps.** Paths are
  two screens deep (Mixer) to five (an instrument mod), and a stack makes
  Back mean one thing everywhere — pop, and close when empty — instead of
  every screen knowing its own depth.
- **Naming**: generic and type-specific parameters take the instrument
  (`CUT1A`); a mod parameter takes the MOD SLOT (`ATK2`), because the
  instrument is chosen once at the top and applies to everything under it,
  while which of four slots you are looking at is what actually
  distinguishes two otherwise identical knobs on screen. Both together
  (`ATK21A`) does not fit the ~5-character cell.

### Multi-knob graphics (Schwung's viz layer)

Several knobs can now share ONE picture instead of each drawing a dial —
`Filter (3 knobs)`, `Envelope (3/4 knobs)` per mod type, `LFO (3 knobs)`.
This is Schwung's existing `viz` system, not a new drawing path:

- A module DECLARES a graphic on its own `chain_params` — each member key
  carries `viz: { group, kind, role }` — and `resolveViz()` turns those into
  groups that `renderPage` draws in place of the member cells. Roles are
  viz.mjs's vocabulary: `attack`/`hold`/`decay`/`sustain`/`release` for an
  envelope, `cutoff`/`resonance`/`mode` for a filter, `shape`/`rate`/`depth`
  for an LFO. The drum envelope's PEAK/BODY/DECAY map onto
  attack/hold/decay because that is the shape they describe; the knobs keep
  M8's names.
- **renderPage does not resolve, it only draws** — resolution and drawing
  are deliberately separate in that library, so `drawSongPage` calls
  `resolveViz` itself and passes `viz` in.
- **A group must be contiguous AND within one row.** `isAdjacentRun` refuses
  anything else (a picture cannot span the gap between the two rows of
  cells), so `nextFreeKnobRun` allocates a run inside one row, and a target
  slot from a Shift+touch is only honoured if the whole run fits there —
  touching slot 3 and choosing a 3-knob envelope would otherwise straddle
  the boundary and silently draw nothing.
- **A group with only ONE member left draws NOTHING, and that was a real
  trap.** viz.mjs happily forms a one-role group (a single slot is trivially
  an adjacent run), the envelope drawer then returns early on `< 2` roles,
  and because the slot IS claimed by the group the ordinary cell loop skips
  it — a blank cell. Removing two of an envelope's three knobs is all it
  takes. `ensureSongPageMeta` counts members per group and drops the
  declaration below two, so it falls back to ordinary dials.
- **The mode/shape knob is an enum for DISPLAY only.** `filterModeOf` and
  the LFO drawer decide their picture from the selected option's TEXT, so
  those knobs declare `options` (M8's filter types / LFO shapes) — but they
  still store and send a plain 0-127 CC like every other knob.
  `knobRenderValue` scales the stored value into an option index purely for
  the renderer. Wavsynth carries a longer filter list (its four in-waveform
  modes), so its filter graphic comes from the type rather than the shared
  generic list.

### Two things the tests caught

- **The header is a print too, and it sits at x=1** — inside column 0's x
  band. `findLabelPrint` (which locates the active knob's name label to
  overwrite with its value) picked it as slot 0's label: the readout painted
  over the song name and its background rect ran off the top of the screen,
  `fill_rect` at `y=-1`. The device would clip that silently; the Node
  harness threw. Excluded by being the topmost line on screen — derived from
  the prints themselves, not a hardcoded header height.
- **Duplicate knob names auto-disambiguate by slot, and that is a feature.**
  Three knobs all named `VMV` render as `VMV4`/`VMV5`/`VMV7`:
  `pageCellLabels` detects the collision and derives a discriminator from
  what differs in the KEYS, which for this module's `song:page:slot` keys is
  the slot number. Worth knowing before filing it as a bug.

Also note `findLabelPrint` had to stop counting prints altogether: with
empty slots AND graphic-covered slots both printing nothing, "the labels are
the last N prints" shifts silently into a neighbouring cell. It matches on
POSITION now (column from the x band, row from the y order), which needs
only `SCREEN_WIDTH`/`COLS` — both exported — and returns null for a slot
that printed nothing, which is exactly when the readout should be skipped.

Built and tested (`test_wizard2.mjs`, 40 checks; `test_filter_viz.mjs`, 4);
**device was offline at deploy time, so this is NOT yet on hardware.**

**Round 9: catalogue corrected against the device, and the rule behind it.**

A corrected parameter list arrived from hardware (as an edit of the Round 7
file, merged into Round 8's structure). The corrections are individually
small - `DRY` `C0`, ModFX depth `40`, reverb size `FF`, delay times `30`,
Macrosynth timbre/colour `80`, an `OTT` row, USB sends, a single `DJF`
instead of three DJ-filter rows - but the DELETIONS all share one cause:

**M8 only maps a CC to a parameter that has a VISUAL SLIDER.** The manual
says it twice in adjacent bullets, about the touchscreen and about MIDI CCs,
and it is the rule that decides what may appear in this catalogue at all.
Every selector row is therefore unmappable, and offering one offers a knob
that can never be learned onto anything: FILTER type, LIM, SHAPE, PLAY mode,
SLICE, ALGO, the FM operator shapes, SCALE, CHORD, the ModFX mod type,
reverb FREEZE, the DJ filter's type. All were in the Round 7/8 catalogue.

Two consequences worth recording:

- **FX commands and mappable rows are different namespaces**, and one FX
  command can cover two rows - `XDR` is the delay TIME command and governs
  both the left and right rows, which is why naming knobs after FX commands
  produced a collision (`XDR` used for both "Time R" and "To Reverb"). The
  two reverb-send rows are named `M>R` and `D>R` now: they say what the row
  does, fit the cell, and cannot be mistaken for an FX command.
- **A graphic whose shape depends on a selector cannot read it from a
  knob.** The filter and LFO pictures need a type/wave to draw correctly and
  neither is mappable, so the WIZARD ASKS once, when the graphic is added,
  and the answer is stored with the group. It reaches viz_draw as a
  `span: false` role - viz.mjs's own mechanism for "a role that lends the
  graphic its VALUE without joining the run of cells it covers" - carried on
  a key appended PAST the eight the grid draws, so it costs no slot:
  renderPage's cell loop stops at 8 while collectDeclared walks the whole
  key array. Filter and LFO are two-knob graphics now (cutoff+resonance,
  rate+depth); envelopes are unaffected, every envelope role being a slider.

External Instrument and MIDI Out leave the type list: once their selectors
are ruled out they have nothing of their own. External Instrument is still
fully usable - it carries audio, so its rows ARE the generic set, one
category across.

**The Mods list is still unverified** and is marked PROVISIONAL in the
source: it predates the slider rule, so some of its entries (TRIG, SRC) are
probably selectors, and its defaults are guesses. Confirmed values to come.

Built and tested (`test_wizard2.mjs` 40 checks, `test_filter_viz.mjs` 10
including that a LOWPASS and a HIGHPASS actually draw different curves);
**device offline at deploy time, so Rounds 8 and 9 are both still unverified
on hardware.**

**Round 10: the last hand-drawn text screen is gone.**

The module still carried the 4-line text status it had before any of this -
`line1`-`line4` plus `displayMessage()`, printed at hardcoded y positions
(2, 18, 34, 50). It survived as the pre-connection screen and as
`drawSongPage`'s fallback, and it was the only thing on screen not drawn by
a Schwung component.

Replaced by one `drawStatus(message)` using `drawStatusOverlay` from
`menu_layout.mjs` - a bordered card with a title and a line, which is
Schwung's own answer to "show one status". Two states use it: **"Waiting for
M8..."** before the device answers, and **"Display error"** if
`drawSongPage` ever throws (previously the frozen-frame case, since the
fallback drew stale line text). The "No song page" branch is written but
unreachable: `loadSongs` guarantees a song with a page, so a connected M8
always has something to draw.

The **"Shift held"** readout is deleted outright - it was the only thing
`displayMessage` was still called for at runtime, and it wrote over the
status lines every time Shift was touched.

Everything on screen is now either the knob page or a menu component.

**Round 11: mod defaults confirmed, and a second value scale.**

Confirmed mod defaults arrived (amount `FF` throughout, drum peak `80` /
body `10`, trig decay `40`, LFO freq `10`, and Tracking's `SRC` replaced by
low/high value). Two things came out of checking them:

- **The LFO's graphic and its individual knobs had drifted apart** - the
  individual entries were corrected to `FRQ 10` / `AMT FF` while the
  graphic still said `00`/`00`, so adding the picture and adding the same
  two knobs singly gave different defaults. The cause was structural: every
  mod default was written TWICE, in two hand-kept lists. `modType()` now
  derives the graphic and the individual entries from one shape list, so a
  default is written once and the two cannot disagree.
- **Not every M8 row is a byte.** Tracking's low and high value top out at
  `7F`, because they can refer to note numbers. The hex readout assumed
  0-FF everywhere and doubles what a knob stores, so those two would have
  read exactly double - `7F` shown as `FE`. `M8_NOTE_SCALE` marks the
  exception: a note-scaled default does not halve on the way in and its
  readout does not double on the way out. Only the exception is stored on
  the knob, so ordinary knobs are unchanged on disk and every song written
  before this still loads as byte-scaled, which all of them are.

**`node --check` cannot catch a use-before-declaration.** The scale constant
was referenced from the catalogue while its `const` had failed to land (a
replace whose anchor text no longer existed), which is a temporal-dead-zone
ReferenceError at module evaluation - syntax-valid, and fatal on load. The
Node harness caught it on the first run because it actually IMPORTS the
module. Worth remembering that `node --check` passing means very little
here.

**Round 12: song presets on the alternate step buttons, and two reorderings.**

- **The odd step notes finally have a job.** The LPP grid claims the EVEN
  step notes (16-30, which carry M8's mute states), so the odd ones
  (17-31) - the physical buttons in between, unclaimed since the bank
  system was deleted - are now song presets. The first eight songs sit on
  them in list order: press one to switch. Lit **white** for the song you
  are on, **dim** for a button with a song behind it, **dark** for one
  without, so the row shows both how many songs exist and where you are
  among them. An empty button does nothing rather than clamping onto a
  neighbouring song.
- **Songs reorder with Shift+jog** in Song Management, which is also how a
  song is moved onto a different preset button - the two are the same
  fact, since the buttons are just the first eight list positions. The
  cursor travels with the song so a held Shift keeps moving the same one.
- **Knobs reorder from a `Slot` row** in Knob Settings: click to enter,
  jog to move, swapping with whatever occupies the target so nothing is
  displaced off the page. Within the current page only - a slot IS a
  physical encoder, and moving a knob to a page you are not looking at
  would put it under no encoder at all. A knob keeps its name, CC and
  value; only its position changes. Moving a member of a multi-knob
  graphic can break the group's contiguity, at which point viz.mjs stops
  forming it and the members revert to ordinary dials; moving it back
  restores the picture.

`setLED` caches, so an unchanged colour is never re-sent - which is
correct on the device and a trap in a test that clears its MIDI buffer and
then expects a repaint. `test_presets.mjs` accumulates the last colour per
step across the whole run instead, which is what the hardware is actually
showing.

Note that inserting the `Slot` row shifted every row index below it, which
broke six checks in `test_wizard2.mjs` that reach Add/Remove by counting
jog steps. Worth knowing that the Knob Settings row order is load-bearing
for the tests.

**Round 13: a graphic moves as one block.**

Round 12's knob move stepped a single knob one slot, which for a member of
a multi-knob graphic meant sliding it out from under its own picture: the
group loses contiguity, viz.mjs stops forming it, and the picture vanishes
until the knob is put back. Moving one member was never what was wanted.

`knobMoveBlock` now resolves the edited knob to its whole group (or to
just itself), and the block moves together. Two consequences fall out of
the same change:

- **The step is "next VALID start", not "one slot".** `validBlockStarts`
  enumerates the positions where a block of that size fits inside a single
  row - `[0,1,4,5]` for three knobs, `[0,4]` for four, all eight for a
  lone knob. So a block that cannot slide within its row jumps to the
  other row instead, which is the only way a four-knob envelope can be
  moved at all. It also makes an invalid position unreachable rather than
  merely discouraged.
- **Displaced knobs come back into the vacated slots**, and the two counts
  always match, so nothing is created or lost: a step within a row rotates
  the neighbour around the block, and a jump to the other row swaps the
  two blocks whole.

The `Slot` row reports a range (`1-3`) when a graphic will travel, so the
row says the whole picture moves rather than this one knob.

**Round 14: a Settings menu, global settings, odd-rows view, and why Line
In is advice.**

Shift+jog-click now opens **Settings**, with the song list as its first
row rather than being the whole screen. Same row idiom as Knob Settings -
jog moves, click enters a value row, jog changes it, click leaves - so
there is one way to edit a value in this module rather than two. Back
means "up one" everywhere; picking a song is the deliberate exception
that leaves the menus entirely, because you asked to go and play it.

Settings are **global**, stored beside the songs in `songs.json` and
merged over `DEFAULT_SETTINGS` on load so a file written before a setting
existed still loads. They describe how the module talks to the M8, not
what a song contains - a setting that changed under you when a preset
button switched song would be a nasty surprise.

- `Knob Chan` - the channel the eight song knobs send on (was a hardcoded
  `SONG_KNOB_MIDI_CHANNEL = 3`). Must match M8's CONTROL MAP CHANNEL.
- `Master CC` / `Mstr Chan` / `Mstr Mode` - the master knob gets its own
  CC, channel and absolute/relative send rather than borrowing the knobs'.
- `Odd Rows` - see below.
- `Line In` - opens a page of advice, not a switch.

### The wheel gesture was a PEEK, and a third view exposed that

Touch-and-release toggled the view twice, which with two views meant
"show the other one while I hold, then put it back" - a peek, committed
by clicking while still touching. Nobody had to notice, because with two
views "advance" and "put it back" are the same operation. With three they
are not, and cycling twice would SKIP a view instead of returning.

So the view is remembered on touch and restored on release unless a click
committed it, and a further click while still touching advances again -
which is how the third view is reached in one gesture. The view button
shows which you are on: steady for Top, a pulse for Bottom, a faster
blink for Odd (the animation is the channel nibble of the status byte -
0xA is Pulse2th, 0xD is Blink8th).

**Odd rows** (rows 1,3,5,7; M8 calls them 00,02,04,06) needed a third pad
map and a third CONTROL map - the four track buttons are the right-hand
LPP column of whichever four rows are showing, which is the only thing
that differs between the existing two. Off by default, so anyone who does
not want a third stop never gets one. Turning it off while it is the view
on screen moves you back to Top, or the pads would be left on a layout
the cycle can no longer reach. Idea and behaviour from the "display only
odd rows" mode in damian-/move-anything.

### Line In: not possible from JS in Schwung, and already solved

The pre-Schwung version of this module did it by writing samples straight
into the SPI mmap - reading audio in at offset 2304 and writing audio out
at 256. **Schwung exposes no JS binding for either** (checked by
enumerating every registered binding, not by reading the docs): audio
moved into the shim and into native DSPs. Even with a binding, writing
there would fight the shim, which is already compositing shadow audio,
Master FX, sends and master volume into that same buffer.

Schwung also already ships the feature properly - `linein` is a bundled,
chainable sound generator with input conditioning, a noise gate, HPF and
a safety limiter, and Schwung's feedback protection watches modules
declaring `audio_in` specifically, force-bypassing them at boot and when
headphones are unplugged. Building a second, unguarded one inside this
module is exactly the interference the feature request was worried about.
So the row points at that instead, with the feedback warning.

### Two testing notes

`node --check` passed a **use-before-declaration** again - `DEFAULT_SETTINGS`
referenced `KNOB_MODE_ABSOLUTE` from above its declaration, a
temporal-dead-zone ReferenceError that is fatal on load and invisible to a
syntax check. Second time this exact class has appeared; the harness
caught it both times because it actually imports the module.

And the harness's own `tick()` calls `resetLogs()`, which clears the MIDI
buffer - so a test must never tick between a gesture and the assertion
that reads what that gesture sent. Cost a confusing debugging round.

## Decisions made so far

- **Song list is open-ended**: create / rename / delete, not a fixed count.
  Needs a real browser screen, not step-button addressing.
- **Move-side naming only.** Researched whether the active song could sync to
  whatever song is loaded on the M8 itself (see "Song-sync research" below) —
  ruled out. A "song" here is purely a Move-side named profile, unrelated to
  what M8 currently has loaded.
- **The knob-page display is always live in Performance mode** — it replaces
  today's 4-line text status outright, not a separate screen you switch into.
  Jog turn (`MoveMainKnob`, CC 14 — confirmed completely idle today) scrolls
  through the active song's pages right there, with pads/buttons still
  forwarding to the LPP grid exactly as today. **Shift+Jog-click** (also
  confirmed free) opens a secondary Song Management screen for the heavier
  stuff — rename, browse, create, delete, switch song — which is where the
  full `page_controller.mjs` gesture set (hold-to-reveal, Shift precision,
  Mute+touch reset) lives. See "Input & mode boundary" for the full control
  audit behind these choices.
- **Per-knob data stays name + CC + value.** No parameter-type/range system
  beyond that for now (M8-style short caps labels, coarse/fine step, reset-to-
  default — see "M8-style presentation" below). More can be added later.
- **Clean break.** `knobconfig.json` and all of `changeBank`/`changeSave`/
  `banksDef`/`updateConfig`/etc. are replaced, not migrated.

### Song-sync research

Checked the M8 manual's MIDI Settings View and MIDI Mapping View (the exact
section governing `CTRL SURFACE` — *"Currently only the Novation Launchpad
Pro MK3 is supported"*, i.e. the protocol this module already emulates).
Nothing in the MIDI section (Sync In/Out, Record Note/Velocity/Delay, Control
Map Channel, Song Row Cue Channel, Track MIDI Input) announces song identity,
and MIDI CC mappings are explicitly *"stored within the song file"* and
assigned locally on the M8 (hold OPTION, turn a knob) — never transmitted.
There's no protocol hook to detect *which* song is loaded, or even reliably
that a song *changed*, without inventing behavior M8 was never designed to
send. Not pursuing further.

## Current system (being replaced)

`ui.js`'s "Knob bank management" section (formerly `virtual_knobs.mjs`):
9 fixed `banksDef[]` banks (8 general + 1 "Main" volume bank) × 9 knobs each
(CC71-79), each bank pinned to a fixed CC range and color sweep; 9 save slots
(`saveBanks[]`) selected via Shift+Step; state written whole to
`knobconfig.json`. Display is 4 lines of plain text (`line1..line4`) set via
`displayMessage()`. All of this goes away except the physical mapping facts
it encodes (CC71-78 are the 8 knobs, CC79 is the master/volume knob, steps
17/19/21/23/25/27/29/31 are addressable step buttons) and the master-volume
suppression call in `init()`, which stays as-is.

## New data model

```
Song
  id            stable internal id (filename-safe), not shown
  name          user-given, editable
  pages: []
    Page
      name        optional, short
      knobs: [8]
        KnobConfig
          name    M8-style short caps label, e.g. "CUTOFF" (see below)
          cc      1-127, defaults sequential but independently editable
          value   0-127, current value
```

`currentBank`/`currentSave` collapse into a single `activeSongId` +
`activePageIndex`. A song can have any number of pages (including one); the
existing "8 knobs per page" constraint is what `page_plan.mjs` already
assumes (`PAGE_KNOBS` = 8 slots), so pages beyond a song's declared set are
simply not created — no separate "how many pages" setting, it falls out of
how many knobs the user has named.

Open question for implementation: what happens to CC79 (today's "Main"
volume bank, 8 track knobs + main)? It sits outside `page_input.mjs`'s
`KNOB_CC_FIRST..KNOB_CC_LAST` (71-78) — that library only ever speaks for 8
knobs, matching the requested "8 knobs per page" exactly, and confirms CC79
was always a special case even in the current design. Options: keep it as a
song-independent global (today's behavior, unaffected by song switches), fold
it into being page 0 of every song's own page list, or drop the dedicated
"Main" bank entirely now that per-song pages replace what it was standing in
for. Needs a decision before implementation, not before this plan.

## Display: reusing Schwung's param-page system

`src/shared/param_pages/` (`schwung` repo) is explicitly built to be used
outside the native shadow UI — its own README: *"The native shadow UI is one
consumer; a tool module... is meant to be another."* Its core rule (`No param
I/O — values arrive as arguments; the caller does every get_param/set_param`)
is a *better* fit for M8 than for a real chain module: there is no IPC round
trip at all, since the module already owns every knob value locally.

Reused directly (absolute-imported from `/data/UserData/schwung/shared/`,
same convention as `constants.mjs`/`input_filter.mjs` today):

- `param_plan.mjs` (`planPages`, `PAGE_KNOBS`) — turn a song's pages into the
  planner's page list. Since M8 pages are flat (no child levels, no enum
  params), this is close to the simplest case the planner handles.
- `param_meta.mjs` (`buildMetaIndex`) — needs a **synthetic `chain_params`**
  built from the active song's page: 8 entries of
  `{ key: "<songId>:<pageIdx>:<slot>", label: knob.name, type: "int", min: 0,
  max: 127, step: 1 }`. Rebuilt whenever the active song/page changes — same
  shape as the existing `fingerprint`-changed rebuild the library already
  expects (`docs/PARAM_PAGES.md`: "Rebuild when fingerprint changes").
- `render_page.mjs` (`renderPage`) — draws the 8-dial page into a `rect`
  (`{ fillRect, print, textWidth }` context M8 already has via `print`/
  `clear_screen` — needs a small adapter, not new drawing primitives).
- `page_controller.mjs` (`createController`) — the gesture layer: knob feel,
  staggered reads (irrelevant here, no IPC latency, but harmless), hold-to-
  reveal, Shift precision mode, Mute+touch reset. `io.getParam`/`setParam`
  point at the song data structure directly.
- `page_input.mjs` (`decodeInput`) — **already decodes the exact Move CC
  layout this module runs on** (CC71-78 knobs, CC14 jog turn, CC3 jog click,
  CC49 shift, CC51 back, CC88 mute, notes 0-7 touch) — this is the same
  physical hardware, not an approximation, so it should be usable close to
  as-is rather than reimplemented.

Song **browser** (create/rename/delete) is a separate, simpler screen — not
part of param_pages (that library only draws `PAGE_KNOBS`; list-style
browsing is a shadow-UI-native pattern). Plan to look at `drawMenuList`
/list-style rendering in `shadow_ui.js` for the visual convention to match
(scrolling list, no arrows, always a scrollbar per the PARAM_PAGES.md rules
this module should stay consistent with), reimplemented locally since that
function itself isn't part of the shared library — needs a closer look at
exactly what's exported vs. shadow-UI-internal before committing to how much
of it is copy-able.

Version dependency: per `docs/MODULES.md`, per-module settings
(`settings-schema.json`) needed host **0.9.8**; `param_pages` reuse likely
has its own minimum version floor (needs checking against `schwung`'s
changelog/git history for when the current API shape landed) — `module.json`
should get a `min_host_version` bump to match once known.

## Input & mode boundary

### Full control audit

Checked every exported `Move*` constant in `constants.mjs` against every map
in `ui.js`, not just the ones already known to be referenced. The module
forwards essentially its entire surface to emulate a full Launchpad Pro, by
design — almost nothing is free:

| Control | Status |
|---|---|
| CC 71-79 (knobs 1-9) | claimed — becomes the new song/page knobs |
| Notes 0-8 (knob touch) | claimed — value-preview on touch |
| Note 9 (jog touch, `MoveMainTouch`) | claimed — view toggle |
| CC 3 (jog click, `MoveMainButton`) | claimed, but **does not branch on `shiftHeld`** — see below |
| **CC 14 (jog turn, `MoveMainKnob`)** | **unclaimed.** Not in any map, doesn't match `handleMoveKnobs`'s conditions — confirmed no-op today. |
| CC 40-43 (tracks), 49 (shift), 50 (menu), 51 (back), 52 (capture), 54-55 (down/up), 56 (undo), 58 (loop), 60 (copy), 62-63 (left/right), 85-86 (play/rec), 88 (mute), 118-119 (record/delete) | claimed — forwarded to the LPP grid |
| CC 114/115 (`MoveMicOrAudIn`/`MoveSpkrOrAudOut`, jack-detect) | not buttons, not read by the module either way |
| `[99, 99]` entries in `moveControlToLppNoteMapTop`/`Bottom` | **dead.** There is no Move CC 99 (99 only exists as the note `MovePad32` and the color `DarkBlueViolet`) — this pair can never fire from real hardware. Worth deleting, not urgent, unrelated to this plan. |
| Notes 16-31 (steps) | claimed — odd (17-31) for bank-select, even (16-30) forwarded as LPP pads |
| Notes 68-99 (pads) | claimed — main LPP grid |

**CC 14 (`MoveMainKnob`, jog turn) is the one genuinely free control.**
**Shift+jog-click is also available**: the jog-click press handler
(`if (moveControlNumber === moveWHEEL && data[2] === 0x7f) { wheelClicked =
true; return; }`) doesn't check `shiftHeld` today, so Shift+click currently
behaves identically to a plain click — and jog click has never been
forwarded to M8 either way, shift or not. It also doesn't collide with the
host's own escape gesture, which needs Shift+**Volume-touch**+Jog-click (a
three-way combo), not just Shift+Jog-click.

### Design (per your steer)

Not a separate full-screen "editor mode" — the knob display is **always
live** during normal (Performance) use:

- The screen shows the active song's current page (`renderPage`'s 8-dial
  grid) in place of today's 4-line text status, continuously, while pads and
  buttons keep forwarding to the LPP grid exactly as today.
- **Jog turn (`MoveMainKnob`, CC 14)** scrolls through the active song's
  pages live, right there in Performance mode — no mode switch needed, and
  no conflict since it was completely idle before.
- **Shift+Jog-click** opens a secondary **Song Management** screen (rename
  the current song, switch/browse/create/delete songs) — the one place the
  full `page_controller.mjs` gesture set (hold-to-reveal, Mute+touch reset,
  Shift-precision) and the song browser live. LPP pad forwarding is
  suspended while this screen is open, the same way it would be for a
  separate mode — the difference from the earlier draft is that this is the
  *exception* screen entered deliberately, not the default state knob
  editing lives behind.

This is simpler than the two-mode split in the previous draft: only one
thing (Song Management) needs an explicit entry/exit gesture, and it's fully
resolved — Shift+Jog-click opens it, `MoveBack` (CC 51) closes it back to
Performance mode.

## M8-style presentation conventions

From the manual (Instrument / Instrument Modulation / Instrument Pool
views): every M8 parameter is shown as a short caps label (`CUTOFF`, `RES`,
`AMP`, `PAN`, `LIM`, `DRV`, `MIX`, `DEL`, `REV`...), and the editing
convention is uniform everywhere — `EDIT+UP/DOWN` = large steps,
`EDIT+LEFT/RIGHT` = small steps, `EDIT+OPTION` = reset to default, values in
hex. Applying the same shape here:

- Knob names default-cased/truncated to short caps labels for the page
  display (full name still stored/editable, matching M8's own `NAME` field
  which is longer than what fits inline on other views).
  `page_controller.mjs`'s hold-to-reveal strip is exactly where the full name
  shows, so truncation on the grid itself doesn't lose information.
- Knob turn = M8-style relative step (`decodeDelta`, already what
  `page_input.mjs` gives); no separate coarse/fine gesture is being added
  beyond what the controller already provides (Shift = precision mode).
- Mute+touch = reset a knob's value to a stored default, matching
  `EDIT+OPTION`'s "reset to default" and the controller's existing Mute+
  touch gesture — no new gesture needed, just wiring a per-knob default into
  the data model (add `default` alongside `value` in `KnobConfig`).

## Persistence

New file, module-local (per the earlier config-location fix):
`/data/UserData/schwung/modules/overtake/m8/songs.json` — the array of
`Song` objects above. `knobconfig.json` is not read on upgrade; a device
with the old file simply starts with an empty song list. `saveConfig`'s
existing crash-safety lesson (`host_ensure_dir` unnecessary here since the
module's own directory always exists; null-guard `std.open`'s result before
using it) carries forward into whatever writes `songs.json`.

## Implementation phases

1. **Data model + persistence** — `Song`/`Page`/`KnobConfig` structures,
   `songs.json` load/save, no UI changes yet (keep the old bank system
   working in parallel behind a flag if useful for A/B testing on hardware).
2. **Synthetic chain_params + renderPage wiring** — get one hardcoded test
   song's page drawing correctly via `renderPage`, replacing the 4-line text
   status, no input yet, to validate the rendering adapter (`ctx` shim,
   ScreenWidth/Height, ​font) before touching gestures.
3. **Jog-turn page scrolling** — wire `MoveMainKnob` (CC 14) to page-step
   through the active song live in Performance mode. Confirm pads/buttons
   still forward to the LPP grid unaffected (this control was idle before,
   so nothing to break, but worth a hardware pass to be sure).
4. **page_controller + page_input wiring for knob edits** — knob turns edit
   the current page's values, hold-to-reveal, Shift precision, Mute+touch
   reset, still against one hardcoded song.
5. **Song Management screen** — Shift+Jog-click entry, song browser
   (create/rename/delete/switch), exit gesture confirmed on hardware. Verify
   LPP pad forwarding is correctly suspended while this screen is open and
   resumes cleanly on exit.
6. **Cutover** — delete the old bank/save system, `knobconfig.json` handling,
   and related module.json/help.json text; update `help.json` and
   `CLAUDE.md`'s Features list to describe the new system.

Each phase should get a hardware check before moving to the next, same
workflow as this session's debugging — deploy, exercise the specific gesture
being added, check the debug log if something doesn't look right.

## Open questions for implementation time (not blocking this plan)

- CC79/"Main" bank's role in the new system (see "New data model" above).
- `min_host_version` floor for the `param_pages` API surface being reused.
- Delete the dead `[99, 99]` map entries (see "Full control audit") — minor,
  unrelated cleanup surfaced while auditing controls for this plan.
- How much of `shadow_ui.js`'s list-drawing convention the song browser
  should copy vs. reimplement standalone.
