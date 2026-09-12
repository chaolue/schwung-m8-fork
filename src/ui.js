/*
 * M8 Launchpad Pro Emulator Module
 *
 * Emulates a Novation Launchpad Pro for the Dirtywave M8.
 * Maps Move pads/buttons to LPP protocol and handles bidirectional MIDI.
 */

import * as std from "std";

/* Shared utilities - absolute path for module location independence */
import {
    MoveMenu, MoveBack, MoveCapture, MoveShift, MoveDelete,
    MoveMainButton, MoveMainTouch, MoveMainKnob, MoveMasterTouch,
    MovePlay, MoveRec, MoveLoop, MoveMute, MoveUndo,
    MovePad32, MidiClock, MoveRGBLeds, MoveUp, MoveDown
} from '/data/UserData/schwung/shared/constants.mjs';
import { setLED, setButtonLED, decodeDelta } from '/data/UserData/schwung/shared/input_filter.mjs';
import { buildMetaIndex } from '/data/UserData/schwung/shared/param_pages/param_meta.mjs';
import {
    renderPage, centeredText, fitText, SCREEN_WIDTH, COLS
} from '/data/UserData/schwung/shared/param_pages/render_page.mjs';
import { resolveViz } from '/data/UserData/schwung/shared/param_pages/viz.mjs';
import {
    lfoShapeSample, filterGainAt
} from '/data/UserData/schwung/shared/param_pages/viz_draw.mjs';
import {
    drawMenuList, drawMenuHeader, drawMenuFooter, drawStatusOverlay
} from '/data/UserData/schwung/shared/menu_layout.mjs';
import {
    openTextEntry, isTextEntryActive, handleTextEntryMidi, tickTextEntry, drawTextEntry
} from '/data/UserData/schwung/shared/text_entry.mjs';

/* LPP note layout (10x10 grid) */
const lppNotes = [
    90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
    80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
    70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
    60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
    50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
    40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
    30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
    20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    101, 102, 103, 104, 105, 106, 107, 108,
    1, 2, 3, 4, 5, 6, 7, 8
];

const lppNoteValueMap = new Map([...lppNotes.map((a) => [a, [0, 0, 0]])]);

/* The Launchpad's logo led, which M8 uses to show LIVE MODE. CC 31 is
 * the led BELOW step 16 - not note 31, which is step 16 itself and is
 * the eighth song-preset button. Notes and CCs are separate address
 * spaces on Move, so the two 31s are different leds and do not collide.
 *
 * It was on CC 99, which is a pad. */
const moveLOGO = 31;

/* Move control to LPP note mapping (top view) */
const moveControlToLppNoteMapTop = new Map([
    [55, 80], [54, 70], [62, 91], [63, 92], [85, 20],
    [43, 89], [42, 79], [41, 69], [40, 59],
    [50, 94], [49, 90], [119, 60], [51, 93], [52, 97],
    [88, 2], [56, 1], [86, 10], [60, 50], [58, 3],
    [118, 98], [moveLOGO, 99]
]);

const lppNoteToMoveControlMapTop = new Map([...moveControlToLppNoteMapTop.entries()].map((a) => [a[1], a[0]]));

/* Move control to LPP note mapping (bottom view) */
const moveControlToLppNoteMapBottom = new Map([
    [55, 80], [54, 70], [62, 91], [63, 92], [85, 20],
    [43, 49], [42, 39], [41, 29], [40, 19],
    [50, 94], [49, 90], [119, 60], [51, 93], [52, 97],
    [88, 2], [56, 1], [86, 10], [60, 50], [58, 3],
    [118, 98], [moveLOGO, 99]
]);

const lppNoteToMoveControlMapBottom = new Map([...moveControlToLppNoteMapBottom.entries()].map((a) => [a[1], a[0]]));

/* Move control to LPP note mapping (odd-rows view). Identical to the
 * other two except for the four track buttons, which are the right-hand
 * column of whichever four rows are on screen - here rows 8, 6, 4, 2. */
const moveControlToLppNoteMapOdd = new Map([
    [55, 80], [54, 70], [62, 91], [63, 92], [85, 20],
    [43, 89], [42, 69], [41, 49], [40, 29],
    [50, 94], [49, 90], [119, 60], [51, 93], [52, 97],
    [88, 2], [56, 1], [86, 10], [60, 50], [58, 3],
    [118, 98], [moveLOGO, 99]
]);

const lppNoteToMoveControlMapOdd = new Map([...moveControlToLppNoteMapOdd.entries()].map((a) => [a[1], a[0]]));

/* LPP pad to Move pad mapping (top view) */
const lppPadToMovePadMapTop = new Map([
    [81, 92], [82, 93], [83, 94], [84, 95], [85, 96], [86, 97], [87, 98], [88, 99],
    [71, 84], [72, 85], [73, 86], [74, 87], [75, 88], [76, 89], [77, 90], [78, 91],
    [61, 76], [62, 77], [63, 78], [64, 79], [65, 80], [66, 81], [67, 82], [68, 83],
    [51, 68], [52, 69], [53, 70], [54, 71], [55, 72], [56, 73], [57, 74], [58, 75],
    [101, 16], [102, 18], [103, 20], [104, 22], [105, 24], [106, 26], [107, 28], [108, 30]
]);

const moveToLppPadMapTop = new Map([...lppPadToMovePadMapTop.entries()].map((a) => [a[1], a[0]]));

/* LPP pad to Move pad mapping (bottom view) */
const lppPadToMovePadMapBottom = new Map([
    [41, 92], [42, 93], [43, 94], [44, 95], [45, 96], [46, 97], [47, 98], [48, 99],
    [31, 84], [32, 85], [33, 86], [34, 87], [35, 88], [36, 89], [37, 90], [38, 91],
    [21, 76], [22, 77], [23, 78], [24, 79], [25, 80], [26, 81], [27, 82], [28, 83],
    [11, 68], [12, 69], [13, 70], [14, 71], [15, 72], [16, 73], [17, 74], [18, 75],
    [101, 16], [102, 18], [103, 20], [104, 22], [105, 24], [106, 26], [107, 28], [108, 30]
]);

const moveToLppPadMapBottom = new Map([...lppPadToMovePadMapBottom.entries()].map((a) => [a[1], a[0]]));

/* LPP pad to Move pad mapping (odd-rows view).
 *
 * LPP rows 8, 6, 4 and 2 instead of a contiguous four, so a 4-row Move
 * screen covers the whole 8-row phrase at half resolution. Ported from
 * the "display only odd rows" mode in damian-/move-anything.
 *
 * WHICH FOUR ROWS IS EASY TO GET WRONG BY ONE. LPP row 8 (81-88) is the
 * TOP row - the Top view maps it to Move pad 92, Move's top left - so
 * M8's rows 00, 02, 04, 06 are LPP 8, 6, 4, 2, NOT 7, 5, 3, 1. The first
 * version used the odd LPP numbers, which reads plausibly and silently
 * shows M8 rows 01/03/05/07 instead: every row present but the first one
 * missing. */
const lppPadToMovePadMapOdd = new Map([
    [81, 92], [82, 93], [83, 94], [84, 95], [85, 96], [86, 97], [87, 98], [88, 99],
    [61, 84], [62, 85], [63, 86], [64, 87], [65, 88], [66, 89], [67, 90], [68, 91],
    [41, 76], [42, 77], [43, 78], [44, 79], [45, 80], [46, 81], [47, 82], [48, 83],
    [21, 68], [22, 69], [23, 70], [24, 71], [25, 72], [26, 73], [27, 74], [28, 75],
    [101, 16], [102, 18], [103, 20], [104, 22], [105, 24], [106, 26], [107, 28], [108, 30]
]);

const moveToLppPadMapOdd = new Map([...lppPadToMovePadMapOdd.entries()].map((a) => [a[1], a[0]]));

/* ------------------------------------------------------------- LED values
 *
 * MOVE HAS TWO KINDS OF LED AND THEY SPEAK DIFFERENT LANGUAGES.
 *
 * An RGB led (every pad, all 16 steps, Play, Rec, Sample and the four row
 * buttons) reads its value as an INDEX INTO THE PALETTE in constants.mjs.
 * A white led (Back, Menu, Capture, Loop, Mute, Delete, Copy, Undo, Shift
 * and the arrows) reads the same byte as a BRIGHTNESS, 0-127.
 *
 * The two greys below were brightnesses - 0x10 dim, 0x7c bright - and they
 * are correct for a white led. Sent to an RGB one they were read as
 * palette entries, and the palette says something else entirely:
 *
 *     0x10 = 16  -> #31ADFF Azure Blue      (wanted: a dark grey)
 *     0x7c = 124 -> #141414 Dark Grey 2     (wanted: a bright grey)
 *
 * So the song-preset steps lit BLUE where they should have been dim, and
 * Play lit almost black where it should have been bright. Naming them for
 * the surface they belong to is what stops that recurring; ledFor() below
 * makes it structural. */
const WHITE_DIM = 0x10;
const WHITE_BRIGHT = 0x7c;

/* Palette indices, from the table at the top of constants.mjs. */
const RGB_OFF = 0;
const RGB_DIM_GREY = 123;      /* #404040 - visible in a lit room */
const RGB_GREY = 118;          /* #595959 */
const RGB_WHITE = 120;         /* #FFFFFF */

/* The song-preset steps are the module's own row, not the M8's, and they
 * sat in the same white-and-grey as the track buttons directly above
 * them - two rows of the same two colours, telling you nothing about
 * which was which. Amber is the one hue nothing else on this surface
 * uses: the M8's own palette runs white, pink, green, blue and red. */
const RGB_PRESET = 8;          /* #FFC516 bright yellow */
/* Not amber's own dim variant, 79 (#664E08): beside the bright one it
 * still read as the same lamp at the same strength, and which song you
 * were on took a second look. Ochre is a long way down in luminance
 * while still being clearly lit - the row has to survive a lit room,
 * which is what ruled out the darker 80 (#211902). */
const RGB_PRESET_DIM = 6;      /* #491804 ochre */

/* Kept for the LPP colour map below, which addresses pads only. */
/* Only the LPP colour map uses these two now, and only as MOVE PALETTE
 * indices - the led call sites take a level through ledFor() instead.
 * It was 0x7c, a brightness, which as a palette entry is #141414 -
 * lit, technically. The edge buttons carry it, and that is most of why
 * they could not be seen. */
const chrome_dim = 123;        /* #404040 - visible in a lit room */
const green = 0x7e;            /* #00FF00 */
const navy = 0x7d;
const sky = 0x5f;
const red = 0x7f;              /* #FF0000 */
/* THE CURSOR AND THE TRACK BUTTONS ARE BOTH THIS COLOUR (LPP 78), which
 * is why one value answered two separate reports: a pulsing edit-mode
 * cursor that looked white and static beside the white chain pads, and
 * a right-hand column too dim to read. It was 0x5f - #134566 - which is
 * a blue only in the sense that black is. */
const blue = 16;               /* #31ADFF azure blue */
const azure = 0x63;
const white = 0x7a;
const pink = 0x6d;
const aqua = 0x5a;
const black = 0x00;
const lemonade = 0x6b;
const lime = 0x20;
const fern = 0x55;

/* Alias imported constants for local usage */
const moveMENU = MoveMenu;
const moveBACK = MoveBack;
const moveCAP = MoveCapture;
const moveSHIFT = MoveShift;
const moveWHEEL = MoveMainButton;
const movePLAY = MovePlay;
const moveREC = MoveRec;
const moveLOOP = MoveLoop;
const moveMUTE = MoveMute;
const moveUNDO = MoveUndo;
const moveWHEELTouch = MoveMainTouch;
const moveMASTERTouch = MoveMasterTouch;
const moveJogTurn = MoveMainKnob;

/* Which surface a control's led is, so a caller can name a colour once
 * and have it come out right on either. MoveRGBLeds is the list in
 * constants.mjs, so this cannot drift from the hardware. */
const RGB_LED_SET = new Set(MoveRGBLeds);

/* Semantic names, resolved per led. Every call site says what it MEANS
 * - off, dim, bright - instead of a number that is only correct on one
 * of the two surfaces. */
function ledFor(control, level) {
    const rgb = RGB_LED_SET.has(control);
    if (level === "off") return rgb ? RGB_OFF : 0x00;
    if (level === "dim") return rgb ? RGB_DIM_GREY : WHITE_DIM;
    if (level === "bright") return rgb ? RGB_WHITE : WHITE_BRIGHT;
    return rgb ? RGB_GREY : WHITE_DIM;
}

/* Which LPP channels mean "animate this pad".
 *
 * A Launchpad carries the animation in the MIDI CHANNEL of the LED
 * message: channel 1 is static, 2 is flashing, 3 is pulsing. M8 uses it -
 * a selected chain or phrase is sent flashing, and so is every other
 * place that chain appears - and the CONTROL path has always honoured
 * it (see the 0x91 branch at the end of applyLppLed). The PAD path
 * threw it away and relayed everything static, which is why the
 * selection never moved.
 *
 * The value is only a flag here: what the pad then does is decided by
 * tickPadAnimation below, not by Move's own transition. */
const LPP_PAD_ANIMATED = { 0x91: true, 0x92: true };

/* --------------------------------------------------- pad animation
 *
 * ANIMATED IN SOFTWARE, not by the hardware transition.
 *
 * Move inherits Push 2's LED transitions and they are documented
 * (AbletonPush2MIDIDisplayInterface, "LED animation"): base colour on
 * channel 0, then target and transition type on channels 1-15, and a
 * channel-0 write stops a running transition. Three attempts at
 * driving that produced three wrong pictures on the device - both
 * colours in one frame lost the base, target-then-base stopped the
 * animation dead, and base-then-target went back to transitioning from
 * whatever the M8 had painted. The M8 repaints these pads on its own
 * schedule, and every one of those repaints is a channel-0 write, so
 * the base a transition starts from is never reliably ours.
 *
 * Toggling the colour ourselves removes the whole question. It costs
 * one write per animated pad per flip - a handful of pads a few times
 * a second - and it cannot be undone by an M8 repaint, because the
 * next flip overwrites it.
 */

/* What a flashing pad alternates WITH: a near neighbour of the same hue
 * at a clearly different brightness, so the pad reads as one pad
 * breathing rather than as two pads taking turns.
 *
 * Picked by hand rather than derived. The palette's 26 saturated
 * colours do carry a regular dim partner (63 + 2c), and that is still
 * the fallback, but the colours this module flashes are not all in
 * that range - the pure primaries and the greys sit outside it - and
 * where the formula did apply it chose partners so dark they read as
 * off: azure against #134566 looked like blue-to-nothing.
 *
 * A colour that is ALREADY dark takes a BRIGHTER partner instead.
 * Direction does not matter - the pad alternates between the two
 * either way - only that both ends are lit and share a hue. */
const PULSE_PARTNER = {
    0x7a: 118,     /* white   #CCCCCC -> #595959 mid grey, not near-black */
    120: 118,      /* white   #FFFFFF -> #595959 */
    0x7e: 83,      /* green   #00FF00 -> #306609 */
    0x7f: 65,      /* red     #FF0000 -> #661914 */
    16: 20,        /* azure   #31ADFF -> #153999 a deeper blue, still lit */
    32: 12,        /* deep green #007F12 -> #4F8A04, brighter: it is dark already */
    109: 23,       /* dim pink   #3C1166 -> #972BFF */
    95: 16,        /* dim azure  #134566 -> #31ADFF */
    85: 11,        /* dim green  #144D08 -> #34C216 */
    90: 13,        /* dark teal  #0C210B -> #62FF55 */
    99: 18,        /* dim violet #0A1466 -> #1A34FF */
};

function pulsePartnerOf(colour) {
    if (PULSE_PARTNER[colour] !== undefined) return PULSE_PARTNER[colour];
    /* The palette's own dim partner, for any saturated colour not listed. */
    if (colour >= 1 && colour <= 26) return 63 + 2 * colour;
    return black;
}

/* Move note -> the two colours it alternates between. */
const animatedPads = new Map();

/* Ticks per flip. The module ticks at about 44 Hz, so this is about
 * one and a half flips a second - a pulse of roughly 0.8 Hz.
 *
 * Tuned on the device three times: 10 was far too fast, 16 still read
 * as a flicker rather than a pulse. Raise it further to slow it down;
 * nothing else depends on the number. */
const PAD_FLIP_TICKS = 28;
let padFlipCount = 0;
let padFlipOn = false;

/* Pads the M8 has painted statically, waiting to see whether a re-arm
 * follows in the same refresh - see the static branch of applyLppLed.
 * Value is the colour to paint if the stop does stand. */
const padStopPending = new Map();

function applyPendingPadStops() {
    if (!padStopPending.size) return;
    for (const [note, colour] of padStopPending) {
        animatedPads.delete(note);
        move_midi_internal_send([0x09, 0x90, note, colour]);
    }
    padStopPending.clear();
}

/* Only writes on the frames the phase actually changes, so a steady
 * screen costs nothing between flips. */
function tickPadAnimation() {
    applyPendingPadStops();
    if (!animatedPads.size) { padFlipCount = 0; padFlipOn = false; return; }
    if (++padFlipCount < PAD_FLIP_TICKS) return;
    padFlipCount = 0;
    padFlipOn = !padFlipOn;
    for (const [note, pair] of animatedPads) {
        move_midi_internal_send([0x09, 0x90, note, padFlipOn ? pair[1] : pair[0]]);
    }
}

/* Stop a pad animating and leave it on `colour`. */
function disarmPad(note, colour) {
    animatedPads.delete(note);
    padStopPending.delete(note);
    move_midi_internal_send([0x09, 0x90, note, colour]);
}

/* Take every animation off before a full repaint. A view change points
 * the same physical pad at a different LPP note, so an animation left
 * running would keep flipping under the new one. */
function disarmAnimatedPads() {
    for (const note of animatedPads.keys()) {
        move_midi_internal_send([0x09, 0x90, note, black]);
    }
    animatedPads.clear();
    padStopPending.clear();
}

/* Launchpad colour -> Move palette index.
 *
 * TWO DIFFERENT 128-COLOUR TABLES, so an entry missing here does not
 * degrade to an approximate hue - it falls through as a raw index into
 * Move's palette and lands somewhere unrelated.
 *
 * A traced M8 sends 1, 3, 5, 21, 23, 57, 71 and 78; all are covered.
 * Read against Grahack's M8_LPP_recap they mean: 3 white (non-empty
 * chains), 21 green (chains playing), 71 dark pink (empty chains),
 * 78 blue (the edit-mode cursor, and the track buttons), 1 the dim
 * chrome on the edge buttons. */
const lppColorToMoveColorMap = new Map([
    [0x15, green], [0x17, lime], [0x1, chrome_dim], [0x05, red], [0x39, red], [0x03, white], [0x4e, blue],
    [0x47, pink], [0x13, aqua], [0x27, blue], [0x2b, azure], [0x16, fern]
]);

const lppColorToMoveMonoMap = new Map([
    [0x05, 0x7f], [0x78, 0x7f], [0x01, 0x10], [0x07, 0x0f]
]);

/* State */
/* Which four LPP rows the pads show. Top and Bottom have always been a
 * pair toggled by wheel touch; Odd is a third stop, added to the cycle
 * only when the setting is on (see settings.oddRows) so anyone who does
 * not want a third press never gets one. */
const VIEW_TOP = 0;
const VIEW_BOTTOM = 1;
const VIEW_ODD = 2;
let viewMode = VIEW_TOP;

function padMapLppToMove() {
    if (viewMode === VIEW_ODD) return lppPadToMovePadMapOdd;
    return viewMode === VIEW_TOP ? lppPadToMovePadMapTop : lppPadToMovePadMapBottom;
}
function padMapMoveToLpp() {
    if (viewMode === VIEW_ODD) return moveToLppPadMapOdd;
    return viewMode === VIEW_TOP ? moveToLppPadMapTop : moveToLppPadMapBottom;
}
function controlMapLppToMove() {
    if (viewMode === VIEW_ODD) return lppNoteToMoveControlMapOdd;
    return viewMode === VIEW_TOP ? lppNoteToMoveControlMapTop : lppNoteToMoveControlMapBottom;
}
function controlMapMoveToLpp() {
    if (viewMode === VIEW_ODD) return moveControlToLppNoteMapOdd;
    return viewMode === VIEW_TOP ? moveControlToLppNoteMapTop : moveControlToLppNoteMapBottom;
}

/* Which of M8's Launchpad screens is up, tracked from the button that
 * asked for it. M8 starts on the primary Session screen; Back returns to
 * it, Shift+Back reaches a SECOND session screen, Menu is Note and
 * Capture is Sequencer. Nothing is sent back to say so, so the only way
 * to know is to watch what we forward. */
const LP_SESSION = 0;
const LP_SESSION_ALT = 1;
const LP_NOTE = 2;
const LP_SEQ = 3;
let lpMode = LP_SESSION;

/* Odd rows halves the SESSION grid - it puts M8 phrase rows 0, 2, 4, 6
 * on screen at once, so you see a whole phrase at half resolution. The
 * Note and Sequencer screens are not phrase rows at all (a keyboard and
 * a step editor), and the second Session screen is a different grid
 * again, so on any of the three "every other row" describes nothing and
 * just hides half the layout. The third view is therefore offered only
 * on the primary Session screen. */
function oddRowsAvailable() {
    return settings.oddRows && lpMode === LP_SESSION;
}

/* Restated rather than remembered: the screen can change on any button
 * press and the setting can change in Settings, and either one can strand
 * the pads on a layout the cycle no longer reaches. Both call this. */
function reconcileOddRowsView() {
    if (oddRowsAvailable()) return;
    if (viewMode !== VIEW_ODD) return;
    viewMode = VIEW_TOP;
    queuePadRedraw();
    updateMoveViewPulse();
}

/* ------------------------------------------------------------- tracing */

/* Which LPP notes the M8 actually lights, per screen.
 *
 * The module is a blind emulator - it maps notes both ways and has never
 * had to know what M8 puts where. That is fine until a screen turns out
 * to use rows the current view does not show, at which point the pads
 * look dead and there is nothing in the module that can say why. So this
 * records the lit set for a few seconds after each screen change and
 * writes it out as a grid.
 *
 * OFF unless `trace_on` exists beside the module, and read ONCE at init:
 * a file check per MIDI event would cost more than the feature. Delete
 * the file to stop. Writes go to /data/UserData (never the device's
 * root filesystem, which is full). */
/* Derived in a FUNCTION rather than a const: MODULE_DIR is declared
 * further down the file, and a const referring to it from up here is
 * read during module evaluation, when it is still in its temporal dead
 * zone - which throws on import, a failure `node --check` cannot see.
 * A function body is not evaluated until it is called, by which time
 * every declaration has run. */
function tracePath(name) {
    return `${MODULE_DIR}/${name}`;
}
const TRACE_FRAMES = 130;          /* ~3 s at 44 Hz */
let traceOn = false;
let tracePending = [];
let traceFramesLeft = 0;
/* The WHOLE screen, maintained continuously rather than per window.
 * It used to be cleared at the start of each window, so a window only
 * ever showed what CHANGED during it - and since the M8 paints the grid
 * once and then sends deltas, every window after the first looked
 * nearly empty. That reads as "the M8 sent almost nothing", which is a
 * conclusion about the device rather than about the instrument. */
let traceLit = new Map();
/* Every LED message of the window, in order, as [note, channel, colour]. */
let traceEvents = [];
const TRACE_EVENT_CAP = 600;
let traceLabel = "";

function traceWrite(line) {
    if (!traceOn) return;
    tracePending.push(line);
}

/* Appending means re-reading, because std has no append mode here. The
 * log is small (a few lines per screen change) and only written while
 * tracing, so the cost is irrelevant next to losing the history on every
 * flush. */
/* What has already been written, kept in memory.
 *
 * This used to re-READ the whole log on every flush, because std has
 * no append mode here - fine when a flush only happened at the end of
 * a window, and not fine once flushing moved onto a two-second timer:
 * a read plus a full rewrite, blocking, on the UI tick, in the same
 * seconds the nudge is counting ticks and the M8 is painting. It
 * changed the behaviour of the thing it was measuring. */
let traceWritten = "";

function traceFlush() {
    if (!traceOn || !tracePending.length) return;
    traceWritten += tracePending.join("\n") + "\n";
    tracePending = [];
    const f = std.open(tracePath("trace.log"), "w");
    if (f) {
        f.puts(traceWritten);
        f.close();
    }
}

/* Start collecting the lit set for the screen just entered. */
function traceScreen(label) {
    if (!traceOn) return;
    traceReport();
    traceLabel = label;
    traceEvents = [];
    traceFramesLeft = TRACE_FRAMES;
    traceWrite(`--- ${label} (view ${viewMode}, oddAvailable ${oddRowsAvailable()})`);
}

/* `status` carries the CHANNEL, which is where a Launchpad puts the
 * animation: 1 static, 2 blinking, 3 pulsing. Recording it alongside the
 * colour is the whole point of the trace - "the cursor is white and does
 * not blink" has two possible causes (the M8 never sent blue-on-channel-2,
 * or it did and something later overwrote it with white-on-channel-1) and
 * only the ORDER of the messages tells them apart. */
function traceLed(lppNote, velocity, on, status) {
    if (!traceOn) return;
    /* Recorded as the MIDI channel a person counts - 1, 2, 3 - not the
     * status nibble, so the log reads the same way the Launchpad
     * documentation does. */
    const ch = (status & 0x0F) + 1;
    if (on && velocity > 0) traceLit.set(lppNote, [velocity, ch]);
    else traceLit.delete(lppNote);
    if (traceEvents.length < TRACE_EVENT_CAP) traceEvents.push([lppNote, ch, velocity]);
}

/* The lit set as an 8x8 picture, rows 8 (top) down to 1, so it can be
 * compared with the M8's screen directly. A digit is a lit pad. */
function traceReport() {
    if (!traceOn || !traceLabel) return;
    /* The grid, with the ANIMATION as the glyph: a static pad is #, a
     * blinking one B, a pulsing one P. That alone answers whether the
     * cursor is being sent animated at all. */
    const glyph = (v) => (!v ? "." : v[1] === 2 ? "B" : v[1] === 3 ? "P" : "#");
    traceWrite(`  screen after "${traceLabel}": ${traceLit.size} leds lit   (# static, B blink, P pulse)`);
    for (let r = 8; r >= 1; r--) {
        let line = `  row ${r}: `;
        for (let c = 1; c <= 8; c++) line += glyph(traceLit.get(r * 10 + c));
        traceWrite(line);
    }
    /* Every distinct colour on screen, so an unmapped one is visible as a
     * number we do not translate. */
    const colours = new Map();
    for (const [note, v] of traceLit) {
        const key = `${v[0]}${v[1] === 1 ? "" : v[1] === 2 ? " blink" : " pulse"}`;
        colours.set(key, (colours.get(key) || 0) + 1);
    }
    traceWrite("  colours: " + [...colours].map(([k, n]) => `${k} x${n}`).join(", "));
    const edge = [...traceLit.keys()].filter((n) => n < 11 || n > 88 || n % 10 === 0 || n % 10 === 9);
    traceWrite(`  edge/control notes lit: ${JSON.stringify(edge.sort((a, b) => a - b))}`);

    /* Any pad the M8 sent animated at ANY point, with its whole message
     * history. A pad that was sent blinking and is now static was
     * overwritten, and this is where that shows up. */
    const everAnimated = new Set(traceEvents.filter((e) => e[1] !== 1).map((e) => e[0]));
    if (everAnimated.size) {
        traceWrite(`  pads sent animated: ${JSON.stringify([...everAnimated].sort((a, b) => a - b))}`);
        for (const note of everAnimated) {
            const hist = traceEvents.filter((e) => e[0] === note)
                .map((e) => `ch${e[1]}:${e[2]}`).join(" -> ");
            traceWrite(`    note ${note}: ${hist}`);
        }
    } else {
        traceWrite("  pads sent animated: NONE - every message was channel 1");
    }
    traceWrite(`  (${traceEvents.length} led messages in this window${traceEvents.length >= TRACE_EVENT_CAP ? ", capped" : ""})`);
    traceLabel = "";
    traceEvents = [];
    traceFlush();
}

/* Lines written outside a window used to be lost. traceReport blanks
 * the label when it finishes and then early-returns forever after, so
 * tracePending simply grew and was never written - every nudge
 * attempt past the first, and every outcome, reached no file at all.
 * That reads as the code not running. Flush on a timer as well. */
const TRACE_FLUSH_EVERY = 88;          /* about two seconds */
let traceFlushCount = 0;

function traceTick() {
    if (!traceOn) return;
    if (traceFramesLeft > 0) {
        traceFramesLeft--;
        if (traceFramesLeft === 0) traceReport();
    }
    if (++traceFlushCount >= TRACE_FLUSH_EVERY) {
        traceFlushCount = 0;
        traceFlush();
    }
}

function viewStops() {
    return oddRowsAvailable() ? 3 : 2;
}

function advanceViewMode() {
    viewMode = (viewMode + 1) % viewStops();
    queuePadRedraw();
    updateMoveViewPulse();
}

/* EACH SCREEN REMEMBERS ITS OWN HALF.
 *
 * The half used to be one value shared by every screen, which meant
 * that looking at the bottom half of one screen and then switching
 * halves on another silently moved the first one too - come back to it
 * and you were on the top again, with nothing having touched it. So the
 * half is filed under the screen you are leaving and fetched back for
 * the screen you arrive at. A screen not visited yet opens on the top,
 * which is where everything used to start. */
const viewModeByMode = new Map();

function switchLpMode(target) {
    if (target === lpMode) return;
    viewModeByMode.set(lpMode, viewMode);
    const remembered = viewModeByMode.get(target);
    lpMode = target;
    viewMode = remembered === undefined ? VIEW_TOP : remembered;
    queuePadRedraw();
}
let shiftHeld = false;
let liveMode = false;
let isPlaying = false;
let currentView = moveBACK;
let sysexBuffer = [];
const m8InitSysex = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
let m8Connected = false;  /* Track if M8 has connected */
let initRetryTicks = 0;   /* Ticks since startup for retry logic */
const INIT_RETRY_INTERVAL = 60;  /* Send init every ~1 second if not connected */

function drawUI() {
    if (settingsOpen && !songMgmtOpen) {
        try {
            drawSettings();
            return;
        } catch (e) {
            console.log(`drawSettings: render failed: ${e}`);
            closeSettings();
        }
    }
    if (songMgmtOpen) {
        try {
            drawSongMgmt();
            return;
        } catch (e) {
            /* Same reasoning as the drawSongPage try/catch below: must not
             * throw from tick(). Fall all the way back to closing the screen
             * rather than getting stuck showing nothing useful. */
            console.log(`drawSongMgmt: render failed: ${e}`);
            closeSongManagement();
        }
    }
    if (knobEditOpen) {
        try {
            drawKnobEdit();
            return;
        } catch (e) {
            console.log(`drawKnobEdit: render failed: ${e}`);
            closeKnobEdit();
        }
    }
    if (knobWizardOpen) {
        try {
            drawKnobWizard();
            return;
        } catch (e) {
            console.log(`drawKnobWizard: render failed: ${e}`);
            closeKnobWizard();
        }
    }
    if (m8Connected) {
        try {
            if (drawSongPage()) return;
        } catch (e) {
            /* Must not throw: tick() is a globalThis entry point, same as
             * onMidiMessageInternal - an uncaught exception here is fatal to
             * the whole overtake module, not just this frame's draw. Say so
             * on screen rather than leaving the last frame frozen there. */
            console.log(`drawSongPage: render failed: ${e}`);
            drawStatus("Display error");
            return;
        }
        /* loadSongs guarantees a song with a page, so a connected M8 always
         * has a page to draw and this is unreachable in practice. */
        drawStatus("No song page");
        return;
    }
    drawStatus("Waiting for M8...");
}

/* The module's ONLY plain-text screen, and the only one drawn outside a
 * Schwung menu component - so it uses Schwung's own status card rather than
 * hand-placed print() lines at hardcoded y positions, which is what this
 * replaced. Everything else on screen is now either the knob page or one of
 * the menus. */
function drawStatus(message) {
    clear_screen();
    drawStatusOverlay("M8 LPP Emulator", message);
}

function arraysAreEqual(array1, array2) {
    if (array1.length !== array2.length) return false;
    for (let i = 0; i < array1.length; i++) {
        if (array1[i] !== array2[i]) return false;
    }
    return true;
}

/* Progressive resync of the pad grid after a view toggle. Replaying the whole
 * active map synchronously can emit up to ~80 packets from one MIDI callback
 * (40 pads, some doubled); this spreads it across ticks instead, matching the
 * host's recommended progressive-LED pattern (8/frame). */
let padRedrawEntries = null;
let padRedrawIndex = 0;
const PAD_REDRAW_PER_FRAME = 8;

function queuePadRedraw() {
    disarmAnimatedPads();
    let activeMoveToLppPadMap = padMapMoveToLpp();
    padRedrawEntries = [...activeMoveToLppPadMap.entries()];
    padRedrawIndex = 0;
}

function drainPadRedraw() {
    if (!padRedrawEntries || padRedrawIndex >= padRedrawEntries.length) return;
    const end = Math.min(padRedrawIndex + PAD_REDRAW_PER_FRAME, padRedrawEntries.length);
    for (let i = padRedrawIndex; i < end; i++) {
        const [moveNote, lppNote] = padRedrawEntries[i];
        const data = lppNoteValueMap.get(lppNote);
        if (data && data[0] !== 0) {
            /* Straight to the painter, never back through the external
             * handler - see applyLppLed. */
            applyLppLed(data[1], data[2], data[0] & 0xF0, data[0]);
        } else {
            /* M8 has never reported a color for this LPP note under the new
             * view (still the initial [0,0,0] placeholder) - replaying that
             * is a no-op, which is what left the OTHER view's stale color
             * lit on this physical pad. Clear it explicitly instead. */
            move_midi_internal_send([0x09, 0x90, moveNote, black]);
        }
    }
    padRedrawIndex = end;
}

/* Hand a message to the pad keyboard, and put the pads back when it
 * closes.
 *
 * text_entry.mjs reuses the PAD GRID as its keyboard, painting letters
 * over whatever the pads were showing. Closing it restored nothing, so
 * the grid was left carrying Move's own colours until something else
 * happened to trigger a resync.
 *
 * The resync belongs to the KEYBOARD closing rather than to the screen
 * closing, which is why it could not simply live in closeSongManagement:
 * renaming returns you to Song Management, a screen you then stay on, so
 * the only close that had a resync was one that had not happened yet.
 *
 * Returns true when the keyboard consumed the message. */
function routeTextEntryInput(data) {
    if (!isTextEntryActive()) return false;
    handleTextEntryMidi(data);
    if (!isTextEntryActive()) queuePadRedraw();
    return true;
}

/* `force` pushes past setButtonLED's cache, which otherwise suppresses
 * a repeat of a value it believes it already sent - and after the
 * host's LED clear that belief is wrong for every button on the
 * surface. Re-asserting without it is a no-op. */
function updateMoveViewPulse(force) {
    setButtonLED(moveBACK, ledFor(moveBACK, "dim"), force);
    setButtonLED(moveMENU, ledFor(moveMENU, "dim"), force);
    setButtonLED(moveCAP, ledFor(moveCAP, "dim"), force);
    setButtonLED(currentView, ledFor(currentView, "bright"), force);
    /* Which view you are in, as an animation on the view button: Top is
     * steady, Bottom pulses, Odd blinks faster. The channel nibble of the
     * status byte picks the animation (see constants.mjs - 0xA is
     * Pulse2th, 0xD is Blink8th), which is why these are raw sends rather
     * than setButtonLED calls: the shared helper writes channel 0. */
    if (viewMode === VIEW_BOTTOM) {
        move_midi_internal_send([0x0b, 0xBA, currentView, black]);
    } else if (viewMode === VIEW_ODD) {
        move_midi_internal_send([0x0b, 0xBD, currentView, black]);
    }
}

/* Song presets on the ALTERNATE step buttons.
 *
 * The LPP grid claims the EVEN step notes (16-30 - they carry M8's mute
 * states, see lppPadToMovePadMapTop), so these odd ones are the physical
 * buttons in between, unclaimed since the bank system was deleted. The
 * first eight songs sit on them in list order, which is why reordering
 * songs in Song Management is also how a song is moved to a different
 * button.
 *
 * Lit white for the song you are on, dim for a button that has a song
 * behind it, dark for one that does not - so the row says both how many
 * songs there are and where you are among them. */
const SONG_STEP_NOTES = [17, 19, 21, 23, 25, 27, 29, 31];

function updateSongStepLeds(force) {
    SONG_STEP_NOTES.forEach((note, i) => {
        const song = songs[i];
        if (!song) { setLED(note, RGB_OFF, force); return; }
        /* Every step here is an RGB led, so these are palette indices
         * rather than brightnesses - ledFor() is not needed. */
        setLED(note, song.id === activeSongId ? RGB_PRESET : RGB_PRESET_DIM, force);
    });
}

/* The host clears every LED about 500ms into the overtake handshake, and
 * markM8Connected can land on either side of that - M8 is often already
 * streaming when the module loads, so the first paint happens BEFORE the
 * clear and is wiped by it. setLED then believes the row is already
 * correct and never repaints, which is why the preset LEDs came up dark.
 *
 * So the row is re-asserted past the cache for the first couple of
 * seconds, whenever the clear actually lands. INIT_RETRY_INTERVAL treats
 * 60 ticks as roughly a second, so this is about two. */
const SONG_STEP_LED_REASSERT_TICKS = 120;
const SONG_STEP_LED_REASSERT_EVERY = 20;
let songStepLedReassert = 0;

function tickSongStepLeds() {
    if (songStepLedReassert <= 0) return;
    songStepLedReassert--;
    if (songStepLedReassert % SONG_STEP_LED_REASSERT_EVERY === 0) updateSongStepLeds(true);
}

/* THE PADS HAVE THE SAME PROBLEM, and it is worse for them.
 *
 * The M8 paints its grid once and then sends only changes, so the
 * opening paint is the whole picture - and it arrives while the host is
 * still clearing LEDs for the module. Whatever lands before the clear
 * is wiped, and the M8 has no reason to send it again. The pads then
 * stay dark until something forces a repaint: a button press, a page
 * change, or toggling the integration off and on at the M8 end. All
 * three are just ways of making the M8 talk again.
 *
 * Nothing is lost though - every LED the M8 sends is remembered in
 * lppNoteValueMap whether or not it reached the pads - so replaying
 * that cache a few times across the first couple of seconds puts the
 * grid back without the M8 having to do anything. */
const PAD_REASSERT_TICKS = 150;
const PAD_REASSERT_EVERY = 30;
let padReassert = 0;

/* ASKING THE M8 TO PAINT, when replaying the cache cannot help.
 *
 * Leaving the module does not tell the M8 anything - it goes on
 * believing a Launchpad is attached - so on the way back in it has no
 * reason to send its grid again, and this time there is no cache to
 * replay either, the module having been reloaded. The pads stay dark
 * until something makes the M8 talk, which is why power-cycling it
 * first avoids the problem.
 *
 * There is no message for this. MIDI has no "device disconnected" from
 * the peripheral end - a host notices a Launchpad leaving because the
 * USB device disappears, which is not something the module can do.
 *
 * What the M8 does repaint for is a SCREEN CHANGE. And it has to be a
 * change: pressing Session while already on Session is a no-op and
 * repaints nothing, which is why asking for it once did not work. So
 * the module steps to Note and straight back to Session, which lands
 * where it started, having painted the whole grid on the way.
 *
 * ARMED FROM init(), NOT FROM markM8Connected. That is the whole
 * reason this did nothing on a reopen: markM8Connected is only ever
 * reached from the incoming-MIDI handler, and an M8 that already
 * believes a Launchpad is attached sends no identity request and no
 * grid - so with the M8 silent the module never considered itself
 * connected, and neither the nudge nor the re-asserts were ever
 * armed. Waiting for the device to speak cannot be the trigger for
 * the code whose job is to make it speak.
 *
 * Conditional on having heard nothing, so an M8 that is already
 * talking is left alone and nobody's screen moves. */
/* RETRIED RATHER THAN TIMED. One attempt at a guessed delay has been
 * wrong three times now - too early, too close together, or the M8 not
 * yet willing to act on input - and each guess costs a round trip to
 * find out. So the module tries, waits to see whether the M8 answered,
 * and tries again if it did not. Three attempts spread over about
 * eight seconds covers a wide range of "not ready yet" without
 * anyone having to know which one it was.
 *
 * The gap between the two presses is a second, not a third of one: the
 * M8 has to finish painting the other screen before the press that
 * takes it back to Session means anything.
 *
 * The screen it goes out to is the SEQUENCER, not Note. Both work -
 * any screen change repaints the grid - but the sequencer is the
 * better one to be caught on for the moment it takes: it is a phrase
 * and a keyboard rather than a bare keyboard, so a nudge that fails
 * to come back leaves you somewhere more useful. */
const M8_NUDGE_TICKS = 60;
const M8_NUDGE_GAP_TICKS = 45;
const M8_NUDGE_SETTLE_TICKS = 90;
const M8_NUDGE_ATTEMPTS = 3;
const M8_PAINTED_ENOUGH = 16;
let m8NudgeAttempts = 0;
const LPP_SESSION_NOTE = 93;
const LPP_SEQ_SCREEN_NOTE = 97;
let m8NudgeStage = 0;
let m8NudgeTicks = 0;
let ledsSeenSinceConnect = 0;

function pressOnM8(lppNote) {
    move_midi_external_send([2 << 4 | 0x9, 0x90, lppNote, 100]);
    move_midi_external_send([2 << 4 | 0x8, 0x80, lppNote, 0]);
}

function armM8Nudge() {
    ledsSeenSinceConnect = 0;
    m8NudgeAttempts = 0;
    m8NudgeStage = 1;
    m8NudgeTicks = M8_NUDGE_TICKS;
}

function tickM8Nudge() {
    if (!m8NudgeStage) return;
    if (--m8NudgeTicks > 0) return;

    if (m8NudgeStage === 1) {
        /* A handful of messages is not a repaint. The M8 paints its
         * grid in dozens - the first connect of a session traces at
         * around sixty - so anything under this is housekeeping and
         * the screen still needs asking for. */
        if (ledsSeenSinceConnect >= M8_PAINTED_ENOUGH) {
            traceWrite(`  nudge: M8 painted on its own (${ledsSeenSinceConnect} leds)`);
            m8NudgeStage = 0;
            return;
        }
        m8NudgeAttempts++;
        traceWrite(`  nudge ${m8NudgeAttempts}: heard ${ledsSeenSinceConnect}, pressing Sequencer`);
        pressOnM8(LPP_SEQ_SCREEN_NOTE);
        m8NudgeStage = 2;
        m8NudgeTicks = M8_NUDGE_GAP_TICKS;
        return;
    }

    if (m8NudgeStage === 2) {
        traceWrite(`  nudge ${m8NudgeAttempts}: pressing Session (heard ${ledsSeenSinceConnect})`);
        pressOnM8(LPP_SESSION_NOTE);
        m8NudgeStage = 3;
        m8NudgeTicks = M8_NUDGE_SETTLE_TICKS;
        return;
    }

    /* Did it work? If the M8 answered, stop. If not, and there are
     * attempts left, go round again - the failure is always "not yet",
     * never "never". */
    if (ledsSeenSinceConnect >= M8_PAINTED_ENOUGH || m8NudgeAttempts >= M8_NUDGE_ATTEMPTS) {
        traceWrite(`  nudge: finished after ${m8NudgeAttempts}, heard ${ledsSeenSinceConnect} leds`);
        m8NudgeStage = 0;
        return;
    }
    m8NudgeStage = 1;
    m8NudgeTicks = 1;
}

function tickPadReassert() {
    if (padReassert <= 0) return;
    /* Tested BEFORE the decrement, so the first sweep goes out on the
     * very next tick rather than a period later - the clear may
     * already have happened by the time we are connected. */
    const due = padReassert % PAD_REASSERT_EVERY === 0;
    padReassert--;
    if (!due) return;
    /* queuePadRedraw only covers the PADS - its entries come from the
     * pad map. The buttons down the sides, Play and the logo travel
     * through the CONTROL map and were cleared by the same sweep, so
     * they need replaying too. */
    queuePadRedraw();
    reassertControlLeds();
    updateMoveViewPulse(true);
    updatePLAYLed(true);
    /* The song-preset steps are the module's OWN leds, not the M8's,
     * and the same clear takes them out. They have their own window
     * too, but sweeping them here keeps the two in step. */
    updateSongStepLeds(true);
}

/* Repaint every side button, and the logo, from what the M8 last said
 * about it. These are raw CC writes inside applyLppLed rather than
 * cached ones, so replaying the remembered message is enough. A
 * control the M8 has never lit is left alone: some of them are the
 * module's own and updateMoveViewPulse owns those. */
function reassertControlLeds() {
    for (const lppNote of controlMapMoveToLpp().values()) {
        const data = lppNoteValueMap.get(lppNote);
        if (data && data[0] !== 0) applyLppLed(data[1], data[2], data[0] & 0xF0, data[0]);
    }
}

/* Pressing one of those buttons switches song. Silent for a button with
 * no song behind it rather than wrapping or clamping onto another song -
 * an empty preset should do nothing, not something surprising. */
function selectSongByStep(index) {
    const song = songs[index];
    if (!song || song.id === activeSongId) return;
    activeSongId = song.id;
    activePageIndex = 0;
    cachedSongId = null;   /* different song, different page shape */
    markSongsDirty();
    updateSongStepLeds();
}

function updatePLAYLed(force) {
    if (!liveMode && !isPlaying) setButtonLED(movePLAY, ledFor(movePLAY, "bright"), force);
    if (!liveMode && isPlaying) setButtonLED(movePLAY, green, force);
    if (liveMode && !isPlaying) setButtonLED(movePLAY, sky, force);
    if (liveMode && isPlaying) setButtonLED(movePLAY, navy, force);
}

function sendLPPIdentity() {
    /* Send LPP identity response to M8 - this tells M8 "I'm a Launchpad Pro" */
    let out_cable = 2;
    let LPPInitSysex = [
        out_cable << 4 | 0x4, 0xF0, 126, 0,
        out_cable << 4 | 0x4, 6, 2, 0,
        out_cable << 4 | 0x4, 32, 41, 0x00,
        out_cable << 4 | 0x4, 0x00, 0x00, 0x00,
        out_cable << 4 | 0x4, 0x00, 0x00, 0x00,
        out_cable << 4 | 0x6, 0x00, 0xF7, 0x0
    ];
    move_midi_external_send(LPPInitSysex);
}

function markM8Connected() {
    if (m8Connected) return;
    m8Connected = true;
    initRetryTicks = 0;
    viewMode = VIEW_TOP;
    loadSongs();
    /* After the songs, so a value set in a browser wins over the copy
     * that was written into songs.json when the module last ran. */
    loadModuleConfig();
    if (traceOn) {
        traceWrite(`=== M8 connected, oddRows ${settings.oddRows} ===`);
        traceScreen("Session (startup)");
    }
    updateSongStepLeds(true);
    songStepLedReassert = SONG_STEP_LED_REASSERT_TICKS;
    padReassert = PAD_REASSERT_TICKS;
    /* Re-armed on a real connect too: this is the ordinary path, where
     * the M8 has just told us it is there and the grid follows. */
    armM8Nudge();
}

function initLPP() {
    sendLPPIdentity();
    markM8Connected();
}

/* ============================================================================
 * Song-based knob configuration (docs/plans/2026-09-10-song-based-knob-config.md)
 *
 * Replaced the fixed 9-bank/9-save-slot system (banksDef/saveBanks/
 * changeBank/changeSave/handleMoveKnobs/knobconfig.json) in the cutover
 * phase - see git history for that code if it's ever needed for reference.
 * ============================================================================ */

const MODULE_DIR = "/data/UserData/schwung/modules/overtake/m8";
const SONGS_PATH = MODULE_DIR + "/songs.json";
const KNOBS_PER_PAGE = 8;
/* The 8 cells are drawn as two rows of 4 (render_page.mjs COLS/ROWS), and a
 * multi-knob graphic may not span the gap between them - see
 * nextFreeKnobRun. */
const KNOBS_PER_ROW = 4;

/* Module settings: GLOBAL, not per song. These describe how the module
 * talks to the M8 - which channel and CC it sends on, how the grid is
 * laid out - rather than anything a song contains, and a setting that
 * changed under you when a preset button switched song would be a nasty
 * surprise. Persisted alongside the songs in songs.json. */

let songs = [];             // Song[]
let activeSongId = null;
let activePageIndex = 0;

/* Autosave is throttled rather than written on every knob-turn tick: a
 * synchronous write on every message while spinning a knob (this runs in
 * shadow_ui, shared with everything else the UI does, not an isolated
 * thread) would be wasteful and could stutter the whole UI. Edits land on
 * disk within SONGS_AUTOSAVE_INTERVAL_MS of the last change instead. */
let songsDirty = false;
let lastSongsSaveAt = 0;
const SONGS_AUTOSAVE_INTERVAL_MS = 2000;

function markSongsDirty() {
    songsDirty = true;
}

function flushSongsIfDirty() {
    if (!songsDirty) return;
    const now = Date.now();
    if (now - lastSongsSaveAt < SONGS_AUTOSAVE_INTERVAL_MS) return;
    saveSongs();
    songsDirty = false;
    lastSongsSaveAt = now;
}

function makeSongId() {
    /* Not exposed to the user - just needs to be stable and unique per song,
     * independent of its (renamable) display name or (reorderable) position. */
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* mode/display are stored as plain indices into these option lists (not
 * strings) - the module owns both storage and interpretation, so there's no
 * external wire format to reconcile via param_pages' values[] mapping. */
/* Abbreviated because they are drawn in a LIST's value column, which is
 * what is left after the label and the label floor: "Absolute" beside
 * "Mstr Mode" ran off the right edge of the screen. */
const KNOB_MODE_OPTIONS = ["Abs", "Rel"];
const KNOB_MODE_ABSOLUTE = 0;
const KNOB_MODE_RELATIVE = 1;
const KNOB_DISPLAY_OPTIONS = ["0-127", "Hex", "0-1", "-1..1"];
const KNOB_DISPLAY_HEX = 1;
const KNOB_DISPLAY_UNIT = 2;
const KNOB_DISPLAY_BIPOLAR = 3;

const DEFAULT_SETTINGS = {
    /* MIDI channel for the song knobs' CCs, 0-15 on the wire. M8's
     * CONTROL MAP CHANNEL (MIDI Settings view) has to agree with this or
     * nothing the knobs send is heard. */
    knobChannel: 3,
    /* The master knob is a song-independent pass-through, so it gets its
     * own channel, CC and send mode rather than borrowing the knobs'. */
    masterChannel: 3,
    masterCc: 79,
    masterMode: KNOB_MODE_ABSOLUTE,
    /* Where the master knob was left. Kept with the settings rather
     * than in a song because the knob belongs to no song, and kept at
     * all so the readout starts where you left it instead of at zero
     * every time the module loads. Restored but NOT sent: pushing a
     * value at the M8 on load would move a parameter nobody touched. */
    masterValue: 0,
    /* Adds a third stop to the wheel-touch view cycle - see ODD_ROWS. */
    oddRows: false,
};
let settings = Object.assign({}, DEFAULT_SETTINGS);

/* ============================================================================
 * M8 parameter catalogue - what the Add Knob wizard offers.
 *
 * M8's MIDI mapping is a LEARN system, not a fixed CC map: you assign a CC
 * to a parameter on the M8 itself (cursor on the parameter, hold [OPTION],
 * turn the CC), up to 128 mappings per song, stored in the song file. So
 * nothing here can "address" an M8 parameter by CC - what this catalogue
 * buys is the other three things the wizard needs: a recognisable NAME, a
 * sensible STARTING VALUE, and (via nextFreeCc) a CC that no other knob in
 * the song is using, so each learn gesture is unambiguous.
 *
 * `m` is the name stem. Where M8 publishes an FX command mnemonic for the
 * parameter (the Mixer & Effects Commands and common Instrument FX Commands
 * appendices), that mnemonic IS the stem, so a knob and the tracker's FX
 * column call the same thing by the same name. The per-instrument-type
 * parameters have FX commands too, but the manual does not print them -
 * "check the FX command help view with the desired instrument in use to see
 * the full list" - so rather than invent mnemonics that might not match the
 * device, those use the parameter name as it appears on M8's own instrument
 * screen, shortened to fit. Every knob can be renamed afterwards anyway.
 *
 * `def` is the default in M8's own 0-255 byte space (what the M8 screen
 * shows in hex); knob.value stores half of it, because a 7-bit CC is 0-127
 * and M8 doubles an incoming CC to reach its native range.
 *
 * The manual's PROSE does not tabulate per-parameter defaults - on the
 * device [EDIT]+[OPTION] resets a parameter to its default, but the values
 * are never printed. The Instrument View page's screenshot does show them,
 * though, for every row an instrument carries, and that image is the source
 * for the common instrument set below. (It is an image, so a text search of
 * the PDF finds nothing - which is how an earlier pass of this catalogue
 * came to omit PAN entirely and put DRY at the wrong value.) Elsewhere the
 * values follow the conventions the manual states in words, plus track
 * volume confirmed from hardware:
 *   0xE0  track volumes (confirmed on hardware), main volume and the
 *         send-return volumes
 *   0xC0  an instrument's DRY, per the Instrument View screenshot
 *   0x80  centre for bipolar controls: PAN (screenshot), DJ filter ("a
 *         value of 80 is off with no filtering"), Sampler DETUNE ("80 being
 *         the center frequency") and Hypersynth SUBOSC
 *   0xFF  stereo width ("00 is mono, FF is stereo") and filter cutoff
 *         (screenshot), i.e. fully open / not filtering
 *   0x00  everything else - sends, resonance, amp, modulation amounts and
 *         the enum-ish selectors, all starting at their first/least value
 * ============================================================================ */

/* The filter's two knobs, as one entry. Stated once because Wavsynth
 * carries a longer type list and would otherwise be a second copy.
 *
 * `modeKnobs` replaces the whole member list for a type whose controls
 * are not cutoff and resonance. M8's LP>HP is a lowpass corner and a
 * HIGHPASS corner, so CUT and RES are the wrong names - and a second
 * CUT/RES pair on one page collides with an ordinary filter's, which
 * render_page disambiguates by appending the slot number ("CUT24").
 *
 * The ORDER differs too, which is why this replaces the list rather
 * than just renaming it. RES is the highpass corner and CUT the lowpass
 * one, so on the response curve RES owns the LEFT edge of the band and
 * CUT the right; putting HP on the left knob makes the pair read the
 * same way round as the picture above them. The roles are looked up by
 * name, so the swap moves the knobs without touching the curve. */
function filterEntry(types) {
    return {
        /* Just "Filter": drawMenuList budgets a fixed ~6px per glyph for
         * a label and then truncates, so "Filter (2 knobs)" was cut
         * mid-word. The count is already in the value column
         * (entryPreview renders it as "2kn"), which is where it belongs. */
        label: "Filter",
        vizKind: "filter",
        vizModeRole: "mode",
        vizModeOptions: types,
        vizModePrompt: "Filter Type",
        modeKnobs: {
            /* Two independent corners and no resonance at all: M8's CUT
             * drives the LOWPASS (FF = wide open) and its RES drives the
             * HIGHPASS (00 = at DC), so both parameters are "off" at
             * their defaults and either one squeezes the band from its
             * own side.
             *
             * LOWPASS FIRST, which is the M8's own parameter order
             * (it lists CUT above RES). M8 mapping is a LEARN system,
             * so the natural gesture is to walk down the M8's screen
             * assigning each row to the next knob - and in this order
             * that lands each knob on the parameter its label claims.
             *
             * The pair was HP-first for a while, by request, and it is
             * worth recording why it came back: reversed, the natural
             * learn gesture CROSSES the two, and a crossed pair is
             * indistinguishable from a mirrored graphic. Three rounds
             * went on proving the drawing innocent. The order that
             * cannot be crossed by the obvious gesture wins over the
             * one that reads more tidily.
             *
             * The labels name the M8 parameter as well as the role -
             * the only two in the catalogue that do - so the header
             * reads "Ins02 LP (CUT)" and the mapping is unambiguous at
             * the moment you make it. */
            [FILTER_LP_HP]: [
                { m: "LP", label: "Lowpass (CUT)", def: 0xFF, role: "cutoff" },
                { m: "HP", label: "Highpass (RES)", def: 0x00, role: "resonance" },
            ],
        },
        knobs: [
            { m: "CUT", def: 0xFF, role: "cutoff" },
            { m: "RES", def: 0x00, role: "resonance" },
        ],
    };
}

/* Settings the shared viz layer cannot draw honestly, so no graphic is
 * formed for them and their knobs stay ordinary dials.
 *
 * M8's LP>HP is a lowpass whose RES sets the corner of a one-pole
 * HIGHPASS - two independent corners, and no resonance at all.
 * viz_draw's filterModeOf maps any name containing both "lp" and "hp" to
 * its BANDPASS, and that bandpass is a single hump centred on CUTOFF
 * which narrows and grows a peak as resonance rises: the wrong corner,
 * the wrong behaviour, and a resonant peak the filter does not have.
 *
 * Drawing it correctly needs a mode in viz_draw's own vocabulary - its
 * curve helpers (fillCurveMass, drawColumnCurve, PASS, EDGE) are all
 * module-private, and that file explicitly forbids a graph keeping its
 * own copy of the fill, because a filter that fills differently from the
 * envelope beside it can misrepresent the filter. Until such a mode
 * exists, no picture beats a wrong one. */
/* Written the way a person reads them rather than the way M8's screen
 * abbreviates them - the M8 is squeezing these into a hardware font and
 * we are not. They still have to be M8's words: viz_draw's filterModeOf
 * reads the selected option's TEXT to pick a response curve, so
 * "Bandstop" is a decision and not a spelling.
 *
 * LP > HP keeps its abbreviation on purpose. filterModeOf recognises the
 * pair only through a ">" (`lp\s*>\s*hp` or `lowpass\s*>\s*highpass`);
 * anything else containing both words - "LP to HP" - falls through to
 * the rule below it and is drawn as a BANDPASS, which is the wrong
 * corner and a resonant peak the filter does not have. The spelt-out
 * form matches too but is too long for a menu row. */
/* Declared up here rather than beside M8_FILTER_TYPES, which is where
 * they read naturally: VIZ_MODE_WAS below is keyed by FILTER_LP_HP, and
 * a const is in its temporal dead zone until its own line runs - so the
 * module threw on import, which `node --check` cannot see. */
const FILTER_OFF = "Off";
const FILTER_LP_HP = "LP > HP";

/* Shape ids for the three waveforms Schwung gained for M8's sake (see
 * the viz-lfo-exponential-and-square-up branch). An OLDER Schwung has no
 * case for them and lfoShapeSample falls through to its sine default, so
 * sampling one against a sine is a reliable way to ask whether this
 * host can draw it - and cheaper than shipping two builds of the
 * module or guessing from a version number. */
const LFO_SHAPE_PROBE = { "Exp Down": 100, "Exp Up": 101, "Square Up": 102 };

function libraryDrawsShape(id) {
    /* Two probe points, because a single one can coincide: an inverted
     * square and a sine happen to agree at phase 0. */
    return [0.1, 0.35].some((t) => lfoShapeSample(id, t) !== lfoShapeSample(0, t));
}

/* LP>HP is probed the same way, just through the filter model rather
 * than the LFO one: an older Schwung has no such mode and falls through
 * to its lowpass default, so a response that differs from a lowpass is
 * the answer. The probe point sits below the highpass corner, where the
 * two disagree most - a lowpass passes it and LP>HP stops it. */
function libraryDrawsLpHp() {
    return filterGainAt(0.2, "lphp", 0.8, 0.5) !== filterGainAt(0.2, "lp", 0.8, 0.5);
}

/* The spellings these modes were STORED under before the names were
 * written out. This check runs against a saved song, so a rename that
 * forgot them would quietly start drawing a wrong curve for every group
 * created before it - and drawing the wrong curve is the exact failure
 * the unsupported list exists to prevent. */
const VIZ_MODE_WAS = {
    [FILTER_LP_HP]: ["LP>HP"],
    "Exp Down": ["EXP DN"],
    "Exp Up": ["EXP UP"],
    "Square Up": ["SQU UP"],
};

/* Compared on a squashed key, so punctuation and spacing cannot make two
 * spellings of one mode look different - "LP > HP" and "LP>HP" are the
 * same answer. */
function vizModeKey(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const VIZ_UNSUPPORTED_KEYS = (() => {
    const keys = new Set();
    const mark = (name) => {
        keys.add(vizModeKey(name));
        for (const old of VIZ_MODE_WAS[name] || []) keys.add(vizModeKey(old));
    };
    if (!libraryDrawsLpHp()) mark(FILTER_LP_HP);
    /* An exponential drawn as a ramp is the wrong curve, and Square Up
     * drawn as the only square would be inverted - showing the LFO high
     * exactly when it is low. So on a host that cannot draw them, they
     * get plain dials; on one that can, they get their real waveform. */
    for (const name of Object.keys(LFO_SHAPE_PROBE)) {
        if (!libraryDrawsShape(LFO_SHAPE_PROBE[name])) mark(name);
    }
    return keys;
})();

function vizModeUnsupported(mode) {
    return !!mode && VIZ_UNSUPPORTED_KEYS.has(vizModeKey(mode));
}

/* M8's filter types, in the order the Multi-mode Filter Parameters section
 * lists them, plus the OFF the Instrument View screenshot shows as default.
 * These are OPTION TEXT, and their wording is load-bearing: viz_draw.mjs's
 * filterModeOf reads the selected option's text to decide which response
 * curve to draw, matching on words like "lowpass" / "bandpass" / "off". */
/* An M8 parameter's own full scale.
 *
 * Almost every row is a BYTE (00-FF), and a 7-bit CC therefore covers it in
 * steps of two - which is why the hex readout doubles what the knob stores.
 * Some rows are NOTE-valued and top out at 7F instead (Tracking's low and
 * high value, which can refer to note numbers); a CC covers those
 * one-for-one, so they must neither halve on the way in nor double on the
 * way out. Getting it wrong is invisible everywhere except the hex readout,
 * where a note-scaled knob reads exactly double its real value. */
const M8_NOTE_SCALE = 0x7F;

const M8_FILTER_TYPES = [
    FILTER_OFF, "Lowpass", "Highpass", "Bandpass", "Bandstop",
    FILTER_LP_HP, "ZDF Lowpass", "ZDF Highpass",
];

/* Wavsynth adds four modes that apply the filter INTO the waveform. Only
 * offered under Wavsynth, so the other types' lists stay honest. */
const M8_FILTER_TYPES_WAVSYNTH = M8_FILTER_TYPES.concat([
    "Wav Lowpass", "Wav Highpass", "Wav Bandpass", "Wav Bandstop",
]);

/* The LFO shapes the Instrument Modulation View lists, in its order. Like
 * the filter types these are read as TEXT by the viz layer - viz_draw's LFO
 * drawer resolves a shape name to the wave it draws - so the wording
 * matters more than it looks. The "T" (tick-rate) variants of each shape
 * are the same WAVE at a faster rate, so they are left out: they would
 * double the list without changing a single picture. */
/* Spelt out, for the same reason as the filter types - and with a bonus:
 * these names are lfoShapeIdOf's OWN vocabulary, so nothing has to be
 * translated on the way to storage any more. M8's abbreviations did not
 * match it ("RAMP DN" missed `rampdown` by two letters and silently drew
 * a sine), which is what the alias table used to paper over.
 *
 * "Square Down" is deliberate, not a typo for the library's plain
 * "square": viz_draw's one square starts HIGH, which is exactly what M8
 * calls SQU DN, and `squaredown` is matched to it. Square Up is the
 * separate shape added for M8's sake. */
const M8_LFO_SHAPES = [
    "Triangle", "Sine", "Ramp Down", "Ramp Up", "Exp Down", "Exp Up",
    "Square Down", "Square Up", "Random", "Drunk",
];

/* ---------------------------------------------------------------- mixer */

const M8_MIXER_PARAMS = [
    { m: "VT", label: "Track Volume", def: 0xE0, needsTrack: true },
    { m: "VMV", label: "Main Volume", def: 0xE0 },
    { m: "OTT", label: "OTT Volume", def: 0x00 },
    { m: "DJF", label: "DJ Filter", def: 0x80 },
    { m: "VMX", label: "ModFX Volume", def: 0xE0 },
    { m: "VDE", label: "Delay Volume", def: 0xE0 },
    { m: "VRE", label: "Reverb Volume", def: 0xE0 },
    { m: "IVO", label: "Input Volume", def: 0x00 },
    { m: "IMX", label: "Input ModFX", def: 0x00 },
    { m: "IDE", label: "Input Delay", def: 0x00 },
    { m: "IRV", label: "Input Reverb", def: 0x00 },
    { m: "IV2", label: "Input 2 Volume", def: 0x00 },
    { m: "IM2", label: "Input 2 ModFX", def: 0x00 },
    { m: "ID2", label: "Input 2 Delay", def: 0x00 },
    { m: "IR2", label: "Input 2 Reverb", def: 0x00 },
    { m: "USB", label: "USB Volume", def: 0x00 },
    { m: "UMX", label: "USB ModFX", def: 0x00 },
    { m: "UDE", label: "USB Delay", def: 0x00 },
    { m: "URV", label: "USB Reverb", def: 0x00 },
];

/* ---------------------------------------------------------------- sends */

/* Both send effects end in a REVERB SEND row, and neither can be called
 * "XDR"/"XMR" without trouble: XDR is the FX command for the delay's TIME
 * (one command covering both the left and right rows), so reusing it for a
 * different row of the same screen is the one collision this catalogue can
 * actually cause. "D>R" and "M>R" say what the row does, fit the cell with
 * room to spare, and cannot be mistaken for an FX command - which is the
 * right side of the line to be on, since the FX commands and the
 * CC-mappable screen rows are simply different namespaces. */
const M8_SEND_GROUPS = [
    {
        name: "ModFX",
        ctx: "MFX",
        params: [
            { m: "XMM", label: "Mod Depth", def: 0x40 },
            { m: "XMF", label: "Mod Freq", def: 0x80 },
            { m: "XMW", label: "Width", def: 0xFF },
            { m: "M>R", label: "To Reverb", def: 0x00 },
        ],
    },
    {
        name: "Delay",
        ctx: "DLY",
        params: [
            { m: "XDL", label: "Time L", def: 0x30 },
            { m: "XDR", label: "Time R", def: 0x30 },
            { m: "XDF", label: "Feedback", def: 0x80 },
            { m: "XDW", label: "Width", def: 0xFF },
            { m: "D>R", label: "To Reverb", def: 0x00 },
        ],
    },
    {
        name: "Reverb",
        ctx: "REV",
        params: [
            { m: "XRS", label: "Room Size", def: 0xFF },
            { m: "XRD", label: "Decay", def: 0xC0 },
            { m: "XSH", label: "Shimmer", def: 0x00 },
            { m: "XRM", label: "Mod Depth", def: 0x10 },
            { m: "XRF", label: "Mod Freq", def: 0xFF },
            { m: "XRW", label: "Width", def: 0xFF },
        ],
    },
];

/* --------------------------------------------------- instrument: generic */

/* The rows every instrument type carries. Defaults confirmed against the
 * device.
 *
 * WHAT IS NOT HERE IS THE POINT. M8 only maps a CC to a parameter with a
 * VISUAL SLIDER - the manual says so twice, about the touchscreen and about
 * MIDI CCs, in the same sentence pair - so every selector row is
 * unmappable and offering one would offer a knob that can never be learned
 * onto anything. That rules out FILTER type, LIM, SHAPE, PLAY mode, SLICE,
 * ALGO, the FM operator shapes, SCALE, CHORD, the ModFX mod type, reverb
 * FREEZE and the DJ filter's type - all of which earlier passes of this
 * catalogue offered. VOL, PIT and FIN are absent for the older reason: they
 * are FX commands that OFFSET a playing note rather than naming a row the
 * cursor can rest on. */
const M8_INSTRUMENT_GENERIC = [
    /* The filter as ONE GRAPHIC across two knobs. Its TYPE is asked for by
     * the wizard and stored with the group rather than given a knob of its
     * own, because the type is a selector and so cannot be mapped - see
     * vizModeFor and the span:false role ensureSongPageMeta emits. */
    filterEntry(M8_FILTER_TYPES),
    { m: "CUT", label: "Cutoff", def: 0xFF },
    { m: "RES", label: "Resonance", def: 0x00 },
    { m: "AMP", label: "Amp", def: 0x00 },
    { m: "PAN", label: "Pan", def: 0x80 },
    { m: "DRY", label: "Dry", def: 0xC0 },
    { m: "MFX", label: "ModFX Send", def: 0x00 },
    { m: "DEL", label: "Delay Send", def: 0x00 },
    { m: "REV", label: "Reverb Send", def: 0x00 },
];

/* ---------------------------------------------- instrument: type-specific */

/* Only the rows a type has BEYOND the generic set, so this list is what
 * "Instrument Type" offers and the generic set is reached from its own
 * category. External Instrument and MIDI Out are therefore absent: once
 * their selectors (port, channel, bank, the custom CC assignments) are
 * ruled out they have nothing of their own left. External Instrument is
 * still fully usable - it carries audio, so its filter, amp, pan, dry and
 * sends are exactly the generic rows, one category across. */
const M8_INSTRUMENT_TYPES = [
    {
        name: "Wavsynth",
        /* Wavsynth's filter offers four extra in-waveform modes, so its own
         * filter graphic carries the longer type list. */
        filterTypes: M8_FILTER_TYPES_WAVSYNTH,
        params: [
            { m: "SIZ", label: "Size", def: 0x20 },
            { m: "MUL", label: "Mult", def: 0x00 },
            { m: "WRP", label: "Warp", def: 0x00 },
            { m: "SCN", label: "Scan", def: 0x00 },
        ],
    },
    {
        name: "Macrosynth",
        params: [
            { m: "TBR", label: "Timbre", def: 0x80 },
            { m: "COL", label: "Color", def: 0x80 },
            { m: "DEG", label: "Degrade", def: 0x00 },
            { m: "RDX", label: "Redux", def: 0x00 },
        ],
    },
    {
        name: "Sampler",
        params: [
            { m: "STA", label: "Start", def: 0x00 },
            { m: "LST", label: "Loop Start", def: 0x00 },
            { m: "LEN", label: "Length", def: 0xFF },
            { m: "DTN", label: "Detune", def: 0x80 },
            { m: "DEG", label: "Degrade", def: 0x00 },
        ],
    },
    {
        name: "FM Synth",
        params: [
            { m: "RTA", label: "Op A Ratio", def: 0x00 },
            { m: "RTB", label: "Op B Ratio", def: 0x00 },
            { m: "RTC", label: "Op C Ratio", def: 0x00 },
            { m: "RTD", label: "Op D Ratio", def: 0x00 },
            { m: "LVA", label: "Op A Level", def: 0x00 },
            { m: "LVB", label: "Op B Level", def: 0x00 },
            { m: "LVC", label: "Op C Level", def: 0x00 },
            { m: "LVD", label: "Op D Level", def: 0x00 },
            { m: "FBA", label: "Op A Feedback", def: 0x00 },
            { m: "FBB", label: "Op B Feedback", def: 0x00 },
            { m: "FBC", label: "Op C Feedback", def: 0x00 },
            { m: "FBD", label: "Op D Feedback", def: 0x00 },
        ],
    },
    {
        name: "Hypersynth",
        params: [
            { m: "SFT", label: "Shift", def: 0x80 },
            { m: "SWM", label: "Swarm", def: 0x00 },
            { m: "WID", label: "Width", def: 0x00 },
            { m: "SUB", label: "Sub Osc", def: 0x80 },
        ],
    },
];

/* ------------------------------------------------------ instrument: mods */

/* M8 has 4 modulation slots per instrument and each slot can be ANY of these
 * types, so the wizard asks which slot and then which type rather than
 * offering one fixed set of modulator parameters.
 *
 * A type's SHAPE parameters are offered twice - once as a single multi-knob
 * graphic and once as individual knobs - because a graphic needs a
 * contiguous run of free slots on one row and there is not always one to
 * spare. modType() derives both from ONE list so a default is written once:
 * they were two hand-kept lists, and they had already drifted (the LFO's
 * graphic still said FRQ 00 / AMT 00 after the individual entries were
 * corrected to 10 / FF).
 *
 * AMOUNT is an EXTRA for the envelopes, not part of their graphic:
 * viz_draw's envelope reads only the shape roles, so an amount knob inside
 * the span would be a cell the picture covers but never reflects. For an
 * LFO it is the `depth` role and so belongs in the shape list. */
function modType({ name, vizKind, vizModeOptions, vizModePrompt, graphicLabel, shape, extras }) {
    const params = [];
    if (vizKind && shape.length >= 2) {
        const graphic = {
            label: graphicLabel,
            vizKind,
            knobs: shape.map((k) => ({ m: k.m, def: k.def, role: k.role, scale: k.scale })),
        };
        if (vizModeOptions) {
            graphic.vizModeOptions = vizModeOptions;
            graphic.vizModePrompt = vizModePrompt;
        }
        params.push(graphic);
    }
    for (const e of extras || []) params.push(e);
    for (const k of shape) params.push({ m: k.m, label: k.label, def: k.def });
    return { name, params };
}

const M8_MOD_AMOUNT = { m: "AMT", label: "Amount", def: 0xFF };

const M8_MOD_TYPES = [
    modType({
        name: "AHD Envelope",
        vizKind: "envelope",
        graphicLabel: "Envelope",
        extras: [M8_MOD_AMOUNT],
        shape: [
            { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
            { m: "HLD", label: "Hold", def: 0x00, role: "hold" },
            { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
        ],
    }),
    modType({
        name: "ADSR Envelope",
        vizKind: "envelope",
        graphicLabel: "Envelope",
        extras: [M8_MOD_AMOUNT],
        shape: [
            { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
            { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
            { m: "SUS", label: "Sustain", def: 0x80, role: "sustain" },
            { m: "REL", label: "Release", def: 0x80, role: "release" },
        ],
    }),
    modType({
        name: "Drum Envelope",
        vizKind: "envelope",
        graphicLabel: "Envelope",
        extras: [M8_MOD_AMOUNT],
        /* PEAK/BODY/DECAY are the drum envelope's own names; they map onto
         * the envelope drawer's attack/hold/decay roles because that is the
         * shape they describe - a sharp transient, a held body, then a
         * fall. The knobs keep M8's names. */
        shape: [
            { m: "PEK", label: "Peak", def: 0x80, role: "attack" },
            { m: "BOD", label: "Body", def: 0x10, role: "hold" },
            { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
        ],
    }),
    modType({
        name: "LFO",
        vizKind: "lfo",
        graphicLabel: "LFO",
        /* OSC (shape) and TRIG are selectors, so neither can be mapped and
         * neither gets a knob. The wave the graphic draws is asked for once,
         * when the graphic is added, and stored with it. */
        vizModeOptions: M8_LFO_SHAPES,
        vizModePrompt: "LFO Shape",
        shape: [
            { m: "FRQ", label: "Freq", def: 0x10, role: "rate" },
            { m: "AMT", label: "Amount", def: 0xFF, role: "depth" },
        ],
    }),
    modType({
        name: "Trig Envelope",
        vizKind: "envelope",
        graphicLabel: "Envelope",
        extras: [M8_MOD_AMOUNT],
        shape: [
            { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
            { m: "HLD", label: "Hold", def: 0x00, role: "hold" },
            { m: "DEC", label: "Decay", def: 0x40, role: "decay" },
        ],
    }),
    modType({
        name: "Tracking",
        shape: [],
        extras: [
            M8_MOD_AMOUNT,
            { m: "LVL", label: "Low Value", def: 0x00, scale: M8_NOTE_SCALE },
            { m: "HVL", label: "High Value", def: 0x7F, scale: M8_NOTE_SCALE },
        ],
    }),
];

/* ------------------------------------------------------ generic: shapes */

/* Knobs chosen by their PICTURE, with no M8 parameter behind them yet.
 *
 * M8's mapping is a learn system - the device is told which CC drives
 * which parameter, and nothing here addresses a parameter by CC - so a
 * knob's "connection" is only ever a NAME, a sensible starting value and
 * the line the header spells out. Which means it can be decided after the
 * fact, and often wants to be: you know you want an envelope on this row
 * long before you have settled which instrument's third mod slot it is.
 * Knob Settings > Connect fills it in later.
 *
 * By shape rather than by type, so the three 3-knob envelopes M8 has -
 * AHD, Drum and Trig - are ONE row. They draw the identical picture and
 * differ only in what M8 calls their knobs, which is exactly the part
 * Connect supplies; three indistinguishable rows would be three ways to
 * ask for the same graphic. */
/* Filter types whose CURVE is one already offered. ZDF is M8's
 * zero-delay-feedback implementation of the same response - it sounds
 * different and is a real choice on the instrument, but it draws the
 * identical picture, and this list is chosen by picture. Which of the
 * two it is, is a Connect question, exactly as with the three 3-knob
 * envelopes.
 *
 * They stay in the TYPE picker under Instrument, where the choice is the
 * M8 parameter rather than the graphic. */
const VIZ_SAME_AS_TYPE = {
    "ZDF Lowpass": "Lowpass",
    "ZDF Highpass": "Highpass",
};

function fixedModeEntry(base, label, mode) {
    const entry = Object.assign({}, base, { label, fixedVizMode: mode });
    /* The mode is answered here, so the wizard must not ask for it. */
    delete entry.vizModeOptions;
    delete entry.vizModePrompt;
    return entry;
}

const M8_GENERIC_SHAPES = (() => {
    const out = [
        {
            label: "Envelope (3)", vizKind: "envelope",
            knobs: [
                { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
                { m: "HLD", label: "Hold", def: 0x00, role: "hold" },
                { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
            ],
        },
        {
            label: "Envelope (4)", vizKind: "envelope",
            knobs: [
                { m: "ATK", label: "Attack", def: 0x00, role: "attack" },
                { m: "DEC", label: "Decay", def: 0x80, role: "decay" },
                { m: "SUS", label: "Sustain", def: 0x80, role: "sustain" },
                { m: "REL", label: "Release", def: 0x80, role: "release" },
            ],
        },
    ];
    /* Built from the same entries the connected paths use, so a shape
     * offered here cannot describe different knobs from the one reached
     * through Instrument. */
    const filter = filterEntry(M8_FILTER_TYPES);
    for (const t of M8_FILTER_TYPES) {
        if (VIZ_SAME_AS_TYPE[t] || t === FILTER_OFF) continue;
        out.push(fixedModeEntry(filter, `Filter ${t}`, t));
    }
    const lfo = M8_MOD_TYPES.find((t) => t.name === "LFO");
    const lfoGraphic = lfo && lfo.params.find((p) => p.vizKind === "lfo");
    if (lfoGraphic) {
        for (const s of M8_LFO_SHAPES) out.push(fixedModeEntry(lfoGraphic, `LFO ${s}`, s));
    }
    return out;
})();

function makeKnobConfig(cc, opts) {
    const o = opts || {};
    /* A byte-scaled default halves into the 0-127 the knob stores and
     * sends; a note-scaled one is already in that range. See M8_NOTE_SCALE. */
    const noteScaled = o.scale === M8_NOTE_SCALE;
    const raw = o.def === undefined ? 0 : (noteScaled ? o.def : o.def / 2);
    const value = Math.max(0, Math.min(127, Math.round(raw)));
    const knob = {
        name: o.name || "PRM",
        cc,
        value,
        default: value,
        mode: KNOB_MODE_ABSOLUTE,
        display: o.display === undefined ? KNOB_DISPLAY_HEX : o.display,
    };
    /* Only the exception is stored, so an ordinary knob's saved form is
     * unchanged and every song written before this still loads as
     * byte-scaled - which is what all of them are. */
    if (noteScaled) knob.scale = M8_NOTE_SCALE;
    /* What the wizard was pointing at when this knob was made - shown in
     * the header while the knob is touched. See commitWizardEntry. */
    if (o.detail) knob.detail = o.detail;
    /* Membership of a multi-knob graphic: which group, what it draws, and
     * this knob's part in it (viz.mjs's role vocabulary). */
    if (o.viz) knob.viz = o.viz;
    return knob;
}

/* An empty page: 8 slots, none filled. Slots are POSITIONS, not a list -
 * a knob keeps the physical encoder it was added to, and removing one
 * leaves a hole rather than sliding its neighbours under the user's
 * fingers. Songs saved before knobs became individual have all 8 filled,
 * which is just a full page and needs no migration. */
function makeSongPage(name) {
    return { name: name || "", knobs: new Array(KNOBS_PER_PAGE).fill(null) };
}

function makeSong(name) {
    return { id: makeSongId(), name: name || "New Song", pages: [makeSongPage()] };
}

/* Lowest CC in 1-119 that no knob anywhere in this song already uses. CC 0
 * is Bank Select MSB and 120-127 are reserved channel-mode messages, so
 * neither end is handed out. */
function nextFreeCc(song) {
    const used = new Set();
    for (const p of song.pages) {
        for (const k of p.knobs) {
            if (k) used.add(k.cc);
        }
    }
    for (let cc = 1; cc <= 119; cc++) {
        if (!used.has(cc)) return cc;
    }
    return 1; /* 119 knobs in one song - reuse rather than refuse */
}

/* Where the next added knob (or run of knobs) goes: the first free run of
 * `count` slots WITHIN ONE ROW, searching the page the user is looking at
 * and then any later page, else a new page appended to the song. Returns
 * { pageIndex, slot }.
 *
 * The row constraint is viz.mjs's, not ours: a graphic is only drawn for a
 * group whose slots are contiguous AND share a row (isAdjacentRun), because
 * a picture cannot span the gap between the two rows of cells. A run of 4
 * therefore fits only at slot 0 or 4. For count 1 this walks 0..7 in order,
 * exactly as a plain "first empty slot" search would. */
function nextFreeKnobRun(song, count) {
    const n = Math.max(1, count | 0);
    for (let p = activePageIndex; p < song.pages.length; p++) {
        const knobs = song.pages[p].knobs;
        for (let base = 0; base < KNOBS_PER_PAGE; base += KNOBS_PER_ROW) {
            for (let start = base; start + n <= base + KNOBS_PER_ROW; start++) {
                let free = true;
                for (let i = 0; i < n; i++) {
                    if (knobs[start + i]) { free = false; break; }
                }
                if (free) return { pageIndex: p, slot: start };
            }
        }
    }
    song.pages.push(makeSongPage());
    return { pageIndex: song.pages.length - 1, slot: 0 };
}

/* Can `count` knobs start at this exact page/slot - free, and all within
 * one row? See nextFreeKnobRun for why the row matters. */
function runFitsAt(song, target, count) {
    const page = song.pages[target.pageIndex];
    if (!page) return false;
    const rowEnd = (Math.floor(target.slot / KNOBS_PER_ROW) + 1) * KNOBS_PER_ROW;
    if (target.slot + count > rowEnd) return false;
    for (let i = 0; i < count; i++) {
        if (page.knobs[target.slot + i]) return false;
    }
    return true;
}

/* ------------------------------------------------- abbreviating the detail */

/* The header's right-hand slot is about 14 characters wide, and "Ins1A "
 * spends six of them before the parameter is named at all. renderPage does
 * shorten an over-long one, but it does it by chopping - "Track Volume"
 * came out as "Tra Volume" - so the words are abbreviated here, where a
 * human picked each one, and the library's fitter is left as the backstop
 * for the few that are still too long.
 *
 * A table of WORDS rather than of labels: the catalogue has ~80 labels
 * built from ~60 words, most of which repeat, and a word table also covers
 * a label added later without anyone remembering to shorten it. */
const M8_LABEL_WORDS = {
    Amount: "Amt", Attack: "Atk", Color: "Col", Cutoff: "Cut",
    Decay: "Dec", Degrade: "Degr", Delay: "Dly", Depth: "Dpt",
    Detune: "Det", Feedback: "Fbk", Filter: "Flt", Highpass: "HP",
    Input: "In", Length: "Len", Level: "Lvl", Lowpass: "LP",
    ModFX: "MFX", Ratio: "Rat", Redux: "Rdx", Release: "Rel",
    Resonance: "Res", Reverb: "Rev", Shift: "Shft", Shimmer: "Shmr",
    Start: "Strt", Sustain: "Sus", Swarm: "Swrm", Timbre: "Tmb",
    Track: "Trk", Value: "Val", Volume: "Vol", Width: "Wid",
};

/* "Input 2 Volume" -> "In 2 Vol" -> "In2 Vol", "Op A Level" -> "OpA Lvl".
 * A bare index reads as part of the thing it indexes, so closing that gap
 * buys a character and loses nothing. */
const M8_LABEL_INDEX_RE = /\b(In|Op) ([0-9A-D])\b/g;

function shortLabel(text) {
    const words = String(text || "").split(" ");
    for (let i = 0; i < words.length; i++) {
        const short = M8_LABEL_WORDS[words[i]];
        if (short) words[i] = short;
    }
    return words.join(" ").replace(M8_LABEL_INDEX_RE, "$1$2");
}

/* Name stem -> what that knob is, so a knob carrying no stored `detail`
 * can still be described.
 *
 * `detail` is attached when the wizard creates a knob, which does
 * nothing for the knobs that already exist - and every knob on a device
 * that has been in use predates the field. Deriving from the NAME fixes
 * those retroactively and costs no storage, so the stored value is now
 * only a more precise answer where one was recorded.
 *
 * Built from the catalogue itself rather than written out again, so a
 * parameter cannot be renamed in one place and described from the
 * other. */
const M8_STEM_INDEX = (() => {
    const index = Object.create(null);
    const add = (m, label, kind, ctx) => {
        if (!m || index[m]) return;          /* first definition wins */
        index[m] = { label: label || m, kind, ctx };
    };
    /* Two passes per list, because a multi-knob GRAPHIC entry lists the same
     * stems as the individual entries beside it but is labelled for the
     * picture rather than the parameter - modType()'s graphic carries
     * "Envelope (3 knobs)" and its members carry no label at all. Taking the
     * graphic's label made CUT read "Filter" and FRQ read "LFO". So the
     * individually-named entries are indexed FIRST and a graphic member is
     * only a fallback, and only when it names itself. */
    const addParams = (params, kind, ctx) => {
        for (const p of params || []) {
            if (p.knobs) continue;
            add(p.m, p.label, kind, ctx);
        }
        for (const p of params || []) {
            if (!p.knobs) continue;
            for (const k of p.knobs) add(k.m, k.label, kind, ctx);
            for (const list of Object.values(p.modeKnobs || {})) {
                for (const k of list) add(k.m, k.label, kind, ctx);
            }
        }
    };
    addParams(M8_MIXER_PARAMS, "mix");
    for (const g of M8_SEND_GROUPS) addParams(g.params, "send", g.ctx);
    addParams(M8_INSTRUMENT_GENERIC, "inst");
    for (const t of M8_INSTRUMENT_TYPES) addParams(typeParamsFor(t), "inst");
    for (const t of M8_MOD_TYPES) addParams(t.params, "mod");
    return index;
})();

/* Longest first, so "DEC" is not matched as "DE". */
const M8_STEMS_BY_LENGTH = Object.keys(M8_STEM_INDEX).sort((a, b) => b.length - a.length);

/* An instrument is always named with BOTH its hex digits - "Ins00",
 * "Ins1A". A knob's own name drops the padding because a 32px cell cannot
 * spare the character, which makes "CUT0" and "CUT10" look like different
 * shapes of the same thing; the header has the room to be unambiguous, and
 * the whole point of it is to say which instrument. */
function instCtx(n) {
    return `Ins${(Number(n) || 0).toString(16).toUpperCase().padStart(2, "0")}`;
}

/* What a knob is connected to: the recorded answer if there is one,
 * otherwise read back out of its name. A mod parameter is named for its
 * SLOT rather than its instrument (see m8KnobName), so a derived mod
 * detail can say "M2 Attack" but not which instrument - the recorded
 * one can, which is why it is still worth storing.
 *
 * Stored LONG and abbreviated on the way out, so a detail recorded before
 * the abbreviations existed shortens too, and so the wizard has one less
 * thing to get right. */
function knobDetail(knob) {
    return shortLabel(knobDetailLong(knob));
}

function knobDetailLong(knob) {
    if (!knob) return "";
    if (knob.detail) return knob.detail;
    const name = String(knob.name || "");
    for (const stem of M8_STEMS_BY_LENGTH) {
        if (!name.startsWith(stem)) continue;
        const entry = M8_STEM_INDEX[stem];
        const suffix = name.slice(stem.length);
        let ctx = "";
        if (entry.kind === "mix") ctx = "MIX";
        else if (entry.kind === "send") ctx = entry.ctx || "";
        /* The suffix is the instrument's hex, unpadded, straight off the
         * name - so it is parsed back rather than reprinted. */
        else if (entry.kind === "inst") ctx = suffix ? instCtx(parseInt(suffix, 16)) : "";
        else if (entry.kind === "mod") ctx = suffix ? `M${suffix}` : "";
        return [ctx, entry.label].filter(Boolean).join(" ");
    }
    return "";
}

/* "VT" + track 3 -> "VT3"; "CUT" + instrument 0x1A -> "CUT1A". Numbers are
 * M8's own hex where they name an instrument, unpadded so a 3-letter stem
 * plus a two-digit instrument still fits the ~5 characters a 32px cell
 * holds. A mod parameter takes the MOD SLOT as its number rather than the
 * instrument - "ATK2" - because the instrument is chosen once at the top of
 * the flow and applies to everything under it, while which of the four mod
 * slots you are looking at is the thing that actually distinguishes two
 * otherwise identical knobs on screen. */
function m8KnobName(stem, number) {
    if (number === null || number === undefined) return stem;
    return `${stem}${typeof number === "number" ? number.toString(16).toUpperCase() : number}`;
}

/* Turn one wizard leaf into knobs on the song.
 *
 * A leaf is either a single parameter (`m`) or a multi-knob graphic
 * (`knobs` + `vizKind`). Both land through here so slot allocation, CC
 * allocation and the page bookkeeping have one implementation.
 *
 * CCs are taken one at a time and AFTER each insertion, because nextFreeCc
 * reads the song: allocating a run up front would hand the same number to
 * every member of a group. */
/* Each member of a group describes ITSELF. The group's own label names the
 * picture ("Envelope (3 knobs)"), so handing it to all three members put
 * that on the header of each of them - less use than the answer derived
 * from the name would have been. modType()'s members carry no label, so
 * the stem index is the fallback, which is the same table knobDetail reads
 * and so cannot disagree with it. */
function memberDetail(ctx, member, entry) {
    /* With no context there is nothing to record that the name does not
     * already carry - and storing one anyway would make an UNCONNECTED
     * Generic shape indistinguishable from a connected knob on the
     * Connect row, which reports exactly this field. */
    if (!ctx) return "";
    const named = member.label
        || (M8_STEM_INDEX[member.m] && M8_STEM_INDEX[member.m].label)
        || (member === entry ? entry.label : "")
        || member.m || "";
    return [ctx, named].filter(Boolean).join(" ");
}

/* The knobs an entry turns into. A mode may replace the list outright -
 * different names and a different order. See filterEntry's modeKnobs. */
function entryMembers(entry, vizMode) {
    const mode = vizMode || entry.fixedVizMode;
    return (mode && entry.modeKnobs && entry.modeKnobs[mode]) || entry.knobs || [entry];
}

function addKnobsFromEntry(song, entry, number, target, vizMode, ctx) {
    const members = entryMembers(entry, vizMode);
    /* A target names the slot the gesture pointed at (the empty cell that
     * was touched). It is only honoured if the WHOLE run fits there within
     * one row - Shift+touching slot 3 and then choosing a 3-knob envelope
     * would otherwise straddle the row boundary, and viz.mjs refuses to
     * draw a group that does, leaving three live knobs and no picture. */
    const place = (target && runFitsAt(song, target, members.length))
        ? target : nextFreeKnobRun(song, members.length);
    const page = song.pages[place.pageIndex];
    if (!page) return null;

    /* One id per ADDED GROUP, not per catalogue entry: adding the same
     * envelope twice must produce two graphics, not one group of six roles
     * that fails the adjacency check and draws nothing. */
    const groupId = entry.vizKind ? `g${makeSongId()}` : null;

    /* Stored verbatim: the option names ARE the vocabulary viz_draw
     * matches on, which is what the readable spellings bought. */
    const storedMode = vizMode;

    members.forEach((member, i) => {
        const slot = place.slot + i;
        if (slot >= KNOBS_PER_PAGE) return;
        const knob = makeKnobConfig(nextFreeCc(song), {
            name: m8KnobName(member.m, number),
            def: member.def,
            scale: member.scale,
            detail: memberDetail(ctx, member, entry),
            viz: groupId ? { group: groupId, kind: entry.vizKind, role: member.role } : undefined,
        });
        /* The graphic's fixed setting - which filter type, which LFO wave -
         * rides on the FIRST member. It is not a knob: the setting is a
         * selector on the M8 and so cannot be mapped to a CC, but the
         * picture is wrong without it, so the wizard asks once and stores
         * the answer here. ensureSongPageMeta turns it into a span:false
         * role, which is viz.mjs's own mechanism for a role that lends the
         * graphic a value without occupying one of its cells. */
        if (i === 0 && groupId && storedMode) knob.vizMode = storedMode;
        page.knobs[slot] = knob;
    });
    activePageIndex = place.pageIndex;
    ensureSparePage(song);
    markSongsDirty();
    return place;
}

/* Re-point knobs that already exist at a different M8 parameter, keeping
 * their SLOTS and their CCs.
 *
 * The CC is what the M8 has been taught, so changing it would silently
 * unlearn the mapping; the slot is a physical encoder the user has
 * already put their hand on. Everything else - name, starting value, the
 * line the header shows, and the picture - describes the parameter and so
 * follows it.
 *
 * A graphic travels as a BLOCK, the same one Slot moves (knobMoveBlock),
 * because connecting one cell of an envelope to something else would
 * leave viz.mjs a group whose members disagree. */
function connectKnobsFromEntry(song, entry, number, vizMode, ctx, index) {
    const page = song.pages[activePageIndex];
    if (!page || !page.knobs[index]) return;
    const block = knobMoveBlock(page, index);
    const members = entryMembers(entry, vizMode);
    const storedMode = vizMode;

    /* Reuse the group id if there is one, so a connected envelope stays
     * the same picture rather than becoming a second group over the same
     * cells. */
    const head = page.knobs[block.start];
    const groupId = entry.vizKind
        ? ((head && head.viz && head.viz.group) || `g${makeSongId()}`)
        : null;

    const paired = Math.min(block.size, members.length);
    for (let i = 0; i < block.size; i++) {
        const knob = page.knobs[block.start + i];
        if (!knob) continue;
        /* A block longer than the entry - a 4-knob envelope connected to a
         * 3-knob one - leaves knobs over. They keep their names but LOSE
         * the group: left in it they would carry a role the new picture
         * does not draw, which is a cell inside the graphic that nothing
         * ever updates. */
        if (i >= paired) {
            delete knob.viz;
            delete knob.vizMode;
            continue;
        }
        const member = members[i];
        const noteScaled = member.scale === M8_NOTE_SCALE;
        const raw = member.def === undefined ? 0 : (noteScaled ? member.def : member.def / 2);
        knob.name = m8KnobName(member.m, number);
        knob.detail = memberDetail(ctx, member, entry);
        /* The old value described the old parameter, so it is not worth
         * keeping - 0xE0 meant "most of the way up" as a track volume and
         * means something else entirely as a filter cutoff. */
        knob.value = Math.max(0, Math.min(127, Math.round(raw)));
        knob.default = knob.value;
        if (noteScaled) knob.scale = M8_NOTE_SCALE;
        else delete knob.scale;
        delete knob.vizMode;
        if (groupId) knob.viz = { group: groupId, kind: entry.vizKind, role: member.role };
        else delete knob.viz;
        if (i === 0 && groupId && storedMode) knob.vizMode = storedMode;
    }
    markSongsDirty();
}

/* Keep an empty page at the end whenever the last one is full.
 *
 * Adding a knob is Shift+touch on an EMPTY SLOT, so a song whose last
 * page is full has no slot left to touch and the gesture dead-ends -
 * the Add Knob row in Knob Settings was the only way through, which is
 * not something anyone finds on their own. A spare page means the
 * obvious gesture always has somewhere to land: jog past the end and
 * there is a page of empty slots waiting.
 *
 * Only ever ONE spare, and only while the last real page is full, so
 * this cannot pile up blank pages - removeKnobAt prunes trailing empties
 * first and then asks for the spare again, which settles either way. */
function ensureSparePage(song) {
    const last = song.pages[song.pages.length - 1];
    if (last && last.knobs.indexOf(null) < 0) song.pages.push(makeSongPage());
}

/* Empty one slot, then drop any now-empty pages off the END of the song.
 * Pages exist because knobs do (nextFreeKnobRun appends one when the last
 * fills up), so a trailing page with nothing on it is just the reverse of
 * that and would otherwise be un-removable - there is no delete-page
 * gesture any more. A page in the MIDDLE is left alone even when empty:
 * removing it would renumber every page after it, moving pages the user
 * scrolls by. A song always keeps at least one page. */
function removeKnobAt(song, pageIndex, slot) {
    const page = song.pages[pageIndex];
    if (!page || !page.knobs[slot]) return;
    page.knobs[slot] = null;
    while (song.pages.length > 1
           && song.pages[song.pages.length - 1].knobs.every((k) => !k)) {
        song.pages.pop();
    }
    /* Clamp BEFORE the spare is added, or removing the last knob from a
     * page lands you on the blank spare rather than on the page that
     * still has knobs on it. */
    activePageIndex = Math.max(0, Math.min(song.pages.length - 1, activePageIndex));
    ensureSparePage(song);
    markSongsDirty();
}

/* The text of songs.json as this module last saw it, so an edit made
 * from the web page can be told apart from our own autosave. */
let lastSongsRaw = null;

function loadSongs() {
    const raw = std.loadFile(SONGS_PATH);
    lastSongsRaw = raw;
    if (raw) {
        try {
            const parsed = std.parseExtJSON(raw);
            if (Array.isArray(parsed)) {
                /* Bare-array format from before the active song was persisted -
                 * read it, but never written again below. */
                songs = parsed;
            } else if (parsed && Array.isArray(parsed.songs)) {
                songs = parsed.songs;
                activeSongId = parsed.activeSongId || null;
                /* Merged over the defaults rather than replacing them, so
                 * a file written before a setting existed still loads and
                 * simply takes that setting's default. */
                settings = Object.assign({}, DEFAULT_SETTINGS, parsed.settings || {});
            }
        } catch (e) {
            /* A malformed songs.json must not crash the module (this runs from
             * markM8Connected, itself called from the MIDI callback) - fall
             * through to the empty-list default below instead. */
            console.log(`loadSongs: failed to parse ${SONGS_PATH}: ${e}`);
        }
    }
    const invented = !songs.length;
    if (invented) songs = [makeSong("New Song")];
    for (const song of songs) ensureSparePage(song);
    if (!activeSongId || !songs.some((s) => s.id === activeSongId)) {
        activeSongId = songs[0].id;
        activePageIndex = 0;
    }
    /* Written only for a song we just invented, and only AFTER the active
     * id is resolved. Saving before that point recorded
     * `activeSongId: null`, which the next load silently repaired - so the
     * file on a fresh install was wrong from the moment it was created and
     * nothing ever said so. */
    if (invented) saveSongs();
    console.log(`loadSongs: ${songs.length} song(s), active="${getActiveSong().name}"`);
}


/* ============================================================================
 * The same settings, from the web UI.
 *
 * Schwung Manager renders a Settings page for any module that ships a
 * settings-schema.json, and stores what you choose in config.json beside
 * it. That file is the web UI's only channel: it never talks to a running
 * module. So the two are kept in step from this side -
 *
 *   - config.json is read at startup and applied over the settings, and
 *     POLLED while running, so a change made in a browser lands on the
 *     device without a restart;
 *   - every change made ON the device is written back to config.json, so
 *     the web page shows what the hardware actually has rather than a
 *     stale copy.
 *
 * Last writer wins, which for a person at one device and one browser is
 * the behaviour they expect. The file is merged rather than replaced, so
 * keys this module does not manage survive.
 *
 * Channels are stored 1-16 here, matching the schema and how everyone
 * numbers them; internally they are 0-15.
 * ============================================================================ */

/* In a function: MODULE_DIR is declared above this, but deriving paths at
 * call time is the habit that keeps this file free of dead-zone faults. */
function configPath() {
    return MODULE_DIR + "/config.json";
}

/* The raw text last seen, so the poll can ignore our own writes and skip
 * parsing an unchanged file. */
let lastConfigRaw = null;
const CONFIG_POLL_TICKS = 90;        /* ~2s at the module's ~44Hz tick */
let configPollTicks = 0;

function settingsAsConfig() {
    return {
        knob_channel: settings.knobChannel + 1,
        master_cc: settings.masterCc,
        master_channel: settings.masterChannel + 1,
        master_mode: settings.masterMode === KNOB_MODE_RELATIVE ? "relative" : "absolute",
        odd_rows: !!settings.oddRows,
    };
}

/* Returns true if anything actually moved, so a caller knows whether the
 * pads and leds need catching up. Each key is checked on its own: a
 * config.json holding only one of them is perfectly legal. */
function applyConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return false;
    let changed = false;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const num = (v) => (typeof v === "number" ? v : parseInt(v, 10));

    if (cfg.knob_channel !== undefined) {
        const ch = clamp(num(cfg.knob_channel) - 1, 0, 15);
        if (!isNaN(ch) && ch !== settings.knobChannel) { settings.knobChannel = ch; changed = true; }
    }
    if (cfg.master_channel !== undefined) {
        const ch = clamp(num(cfg.master_channel) - 1, 0, 15);
        if (!isNaN(ch) && ch !== settings.masterChannel) { settings.masterChannel = ch; changed = true; }
    }
    if (cfg.master_cc !== undefined) {
        const cc = clamp(num(cfg.master_cc), 0, 127);
        if (!isNaN(cc) && cc !== settings.masterCc) { settings.masterCc = cc; changed = true; }
    }
    if (cfg.master_mode !== undefined) {
        const mode = String(cfg.master_mode) === "relative"
            ? KNOB_MODE_RELATIVE : KNOB_MODE_ABSOLUTE;
        if (mode !== settings.masterMode) { settings.masterMode = mode; changed = true; }
    }
    if (cfg.odd_rows !== undefined) {
        const on = cfg.odd_rows === true || cfg.odd_rows === "true" || cfg.odd_rows === 1;
        if (on !== settings.oddRows) { settings.oddRows = on; changed = true; }
    }
    return changed;
}

function readConfigRaw() {
    try {
        return std.loadFile(configPath());
    } catch (e) {
        return null;
    }
}

function loadModuleConfig() {
    const raw = readConfigRaw();
    lastConfigRaw = raw;
    if (!raw) return;
    try {
        applyConfig(std.parseExtJSON(raw));
    } catch (e) {
        console.log(`loadModuleConfig: failed to parse ${configPath()}: ${e}`);
    }
}

function writeModuleConfig() {
    let existing = {};
    const raw = readConfigRaw();
    if (raw) {
        try { existing = std.parseExtJSON(raw) || {}; } catch (e) { existing = {}; }
    }
    const merged = JSON.stringify(Object.assign({}, existing, settingsAsConfig()));
    if (merged === lastConfigRaw) return;
    const f = std.open(configPath(), "w");
    if (!f) return;
    f.puts(merged);
    f.close();
    lastConfigRaw = merged;
}

/* SONGS CAN BE EDITED FROM THE WEB PAGE TOO.
 *
 * web_ui.html rewrites songs.json whole - reordering, renaming, adding
 * and deleting songs - so the file is watched on the same beat as
 * config.json and reloaded when it changes underneath us.
 *
 * Two things are never interrupted: a screen that owns the surface (you
 * are editing on the device, and pulling the list out from under a
 * cursor would be worse than being briefly out of date), and unsaved
 * local edits, which are flushed first and therefore win. Neither can
 * strand the reload - the poll comes round again. */
function tickSongsFile() {
    if (screenOwnsSurface() || songsDirty) return;
    let raw = null;
    try { raw = std.loadFile(SONGS_PATH); } catch (e) { return; }
    if (raw === null || raw === lastSongsRaw) return;
    loadSongs();
    /* loadSongs re-reads the settings block too, so the web UI's
     * config.json has to win again afterwards. */
    loadModuleConfig();
    reconcileOddRowsView();
    updateSongStepLeds(true);
    queuePadRedraw();
    updateMoveViewPulse();
    console.log(`tickSongsFile: reloaded, ${songs.length} song(s)`);
}

/* A browser can change the file at any moment, so it is watched rather
 * than read once. Cheap: an unchanged file costs one read every couple
 * of seconds and no parse. */
function tickModuleConfig() {
    if (++configPollTicks < CONFIG_POLL_TICKS) return;
    configPollTicks = 0;
    tickSongsFile();
    const raw = readConfigRaw();
    if (raw === lastConfigRaw) return;
    lastConfigRaw = raw;
    if (!raw) return;
    let parsed = null;
    try { parsed = std.parseExtJSON(raw); } catch (e) { return; }
    if (!applyConfig(parsed)) return;
    /* Odd rows may have just been switched off under a view that only
     * exists while it is on, and the step leds follow the song list. */
    reconcileOddRowsView();
    queuePadRedraw();
    updateMoveViewPulse();
    markSongsDirty();
}

function saveSongs() {
    const f = std.open(SONGS_PATH, "w");
    if (!f) {
        console.log(`saveSongs: failed to open ${SONGS_PATH} for writing`);
        return;
    }
    const body = JSON.stringify({ activeSongId, settings, songs });
    f.puts(body);
    f.close();
    /* So the watcher below can tell our own write from someone else's. */
    lastSongsRaw = body;
    /* Mirror the settings out to the web UI's file. Done here rather
     * than at each edit site so no future settings row can forget. */
    writeModuleConfig();
}

function getActiveSong() {
    return songs.find((s) => s.id === activeSongId) || songs[0];
}

function getActivePage() {
    const song = getActiveSong();
    if (!song || !song.pages.length) return null;
    if (activePageIndex >= song.pages.length) activePageIndex = 0;
    return song.pages[activePageIndex];
}

/* ============================================================================
 * Settings - Shift+Jog-click opens this, and the song list is one row of
 * it rather than the whole screen.
 *
 * Everything here is GLOBAL (see DEFAULT_SETTINGS): it describes how the
 * module talks to the M8, not what a song contains. Same row idiom as Knob
 * Settings - jog moves, click enters a value row and jog then changes it,
 * click again leaves - so there is one way to edit a value in this module
 * rather than two.
 * ============================================================================ */

/* "songs" and "exit" are ACTION rows: they fire on click and never enter
 * edit mode, the same shape Knob Settings uses for Add/Remove. */
const SETTINGS_ROWS = [
    "songs", "knobChannel", "masterCc", "masterChannel", "masterMode",
    "oddRows", "exit",
];
const SETTINGS_LABELS = {
    songs: "Songs",
    knobChannel: "Knob Chan",
    masterCc: "Master CC",
    masterChannel: "Mstr Chan",
    masterMode: "Mstr Mode",
    oddRows: "Odd Rows",
    exit: "Exit Module",
};
const ONOFF_OPTIONS = ["Off", "On"];

let settingsOpen = false;
let settingsCursor = 0;
let settingsEntered = false;

function openSettings() {
    settingsOpen = true;
    settingsCursor = 0;
    settingsEntered = false;
}

function closeSettings() {
    settingsOpen = false;
    queuePadRedraw();
    updateMoveViewPulse();
    updateSongStepLeds();
}

function settingsRowValue(row) {
    switch (row) {
        case "songs": return String(songs.length);
        /* Channels are stored 0-15 on the wire and shown 1-16, which is
         * how M8 (and everything else) numbers them. */
        case "knobChannel": return String(settings.knobChannel + 1);
        case "masterChannel": return String(settings.masterChannel + 1);
        case "masterCc": return String(settings.masterCc);
        case "masterMode": return KNOB_MODE_OPTIONS[settings.masterMode];
        case "oddRows": return ONOFF_OPTIONS[settings.oddRows ? 1 : 0];
        /* An action row has nothing to show in the value column. */
        case "exit": return "";
        default: return "";
    }
}

function adjustSetting(row, step) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    switch (row) {
        case "knobChannel":
            settings.knobChannel = clamp(settings.knobChannel + step, 0, 15);
            break;
        case "masterChannel":
            settings.masterChannel = clamp(settings.masterChannel + step, 0, 15);
            break;
        case "masterCc":
            settings.masterCc = clamp(settings.masterCc + step, 0, 127);
            break;
        case "masterMode":
            settings.masterMode = clamp(settings.masterMode + step, 0, KNOB_MODE_OPTIONS.length - 1);
            break;
        case "oddRows":
            settings.oddRows = step > 0;
            reconcileOddRowsView();
            break;
        default:
            return;
    }
    markSongsDirty();
}

/* Leave the module the same way the host's own Shift+Vol+Jog-click does.
 * The host runs onUnload for us on the way out, which is what persists the
 * songs, but flushing first keeps the write on this side of the door in
 * case a host build ever exits without the callback. */
function exitModule() {
    closeSettings();
    flushSongsIfDirty();
    if (typeof host_exit_module === "function") host_exit_module();
    else if (typeof host_return_to_menu === "function") host_return_to_menu();
}

function handleSettingsInput(data) {
    if (data[0] !== 0xb0) return;

    const moveControlNumber = data[1];
    const pressed = data[2] === 127;

    if (moveControlNumber === moveSHIFT) {
        shiftHeld = pressed;
        return;
    }

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta === 0) return;
        if (settingsEntered) {
            adjustSetting(SETTINGS_ROWS[settingsCursor], Math.sign(delta));
        } else {
            settingsCursor = Math.max(0, Math.min(SETTINGS_ROWS.length - 1,
                                                  settingsCursor + Math.sign(delta)));
        }
        return;
    }

    if (!pressed) return;

    if (moveControlNumber === moveBACK) {
        if (settingsEntered) { settingsEntered = false; return; }
        closeSettings();
        return;
    }

    if (moveControlNumber !== moveWHEEL) return;

    const row = SETTINGS_ROWS[settingsCursor];
    if (row === "songs") {
        settingsOpen = false;
        openSongManagement();
        return;
    }
    if (row === "exit") {
        exitModule();
        return;
    }
    settingsEntered = !settingsEntered;
}

function drawSettings() {
    clear_screen();
    drawMenuHeader("Settings");
    drawMenuList({
        items: SETTINGS_ROWS,
        selectedIndex: settingsCursor,
        editMode: settingsEntered,
        getLabel: (row) => SETTINGS_LABELS[row],
        getValue: (row) => settingsRowValue(row),
    });
    drawMenuFooter(["Jog: Move", "Click: Edit", "Back: Close"]);
}

/* ============================================================================
 * Song Management screen - Shift+Jog-click to open, Back to close.
 *
 * Owns the whole screen and every control while open: LPP pad/button
 * forwarding is suspended (handleSongMgmtInput is dispatched to BEFORE any of
 * the normal onMidiMessageInternal logic runs, and onMidiMessageExternal's
 * LED relay is gated off - see the two call sites). Pads get reused by
 * text_entry.mjs for typing during rename/create, which is the reason
 * forwarding has to stop rather than just being ignored: M8's own LED
 * updates would otherwise paint over the text-entry keyboard.
 * ============================================================================ */

let songMgmtOpen = false;
let songMgmtCursor = 0;

/* A synthetic first row, not a song - selecting it calls createSong() (same
 * as the Capture-button shortcut below). Every other cursor position is
 * songs[cursor - 1]. */
const ADD_SONG_ITEM = { id: "__add_song__", name: "+ Add Song" };

function songMgmtItems() {
    return [ADD_SONG_ITEM].concat(songs);
}

function openSongManagement() {
    songMgmtOpen = true;
    const activeIndex = songs.findIndex((s) => s.id === activeSongId);
    songMgmtCursor = activeIndex >= 0 ? activeIndex + 1 : 0;
}

function closeSongManagement() {
    songMgmtOpen = false;
    /* Back to Settings, which is where the list was opened from - Back
     * means "up one", not "all the way out", the same as everywhere else
     * in this module. Choosing a song is the exception: it closes the
     * whole thing, because you asked to go and play that song. */
    settingsOpen = true;
    /* M8's LED updates kept updating lppNoteValueMap while this screen owned
     * the pads (see onMidiMessageExternal), just without painting them - so
     * the cache may now be ahead of what the pads are actually showing.
     * Reuse the same resync path the view-toggle uses to catch it up. */
    queuePadRedraw();
    updateMoveViewPulse();
    updateSongStepLeds();
}

/* Picking a song is "go and play this", so it leaves the menus entirely
 * rather than stepping back up to Settings. */
function closeSongManagementToPerform() {
    closeSongManagement();
    settingsOpen = false;
}

function renameSong(song) {
    openTextEntry({
        title: "Song Name",
        initialText: song.name,
        onConfirm: (text) => {
            const trimmed = (text || "").trim();
            if (trimmed) song.name = trimmed;
            markSongsDirty();
        },
    });
}

function createSong() {
    const song = makeSong("New Song");
    songs.push(song);
    songMgmtCursor = songs.length; /* row 0 is Add Song, so song i sits at i + 1 */
    markSongsDirty();
    updateSongStepLeds();
    renameSong(song);
}

/* Shift+jog moves the highlighted song through the list - which is also
 * how it is moved onto a different preset step button, since the first
 * eight songs ARE the eight buttons in list order. The cursor travels
 * with the song, so holding Shift and spinning keeps moving the same one
 * instead of walking off it after the first step. */
function moveSong(step) {
    const from = songMgmtCursor - 1;   /* row 0 is "+ Add Song" */
    if (from < 0) return;
    const to = from + step;
    if (to < 0 || to >= songs.length) return;
    const [song] = songs.splice(from, 1);
    songs.splice(to, 0, song);
    songMgmtCursor = to + 1;
    markSongsDirty();
    updateSongStepLeds();
}

function deleteSong(index) {
    if (songs.length <= 1) return; /* always at least one song */
    const wasActive = songs[index].id === activeSongId;
    songs.splice(index, 1);
    if (songMgmtCursor > songs.length) songMgmtCursor = songs.length;
    if (wasActive) {
        activeSongId = songs[0].id;
        activePageIndex = 0;
    }
    markSongsDirty();
    updateSongStepLeds();
}

function handleSongMgmtInput(data) {
    if (routeTextEntryInput(data)) return;

    const isCCMsg = data[0] === 0xb0;
    if (!isCCMsg) return; /* pads/notes: no meaning here outside text entry */

    const moveControlNumber = data[1];
    const pressed = data[2] === 127;

    /* Shift isn't tracked by the normal dispatch while this screen owns
     * input (that logic lives further down onMidiMessageInternal, which this
     * screen bypasses entirely) - track it here too, since delete uses it as
     * a safety modifier below. */
    if (moveControlNumber === moveSHIFT) {
        shiftHeld = pressed;
        return;
    }

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta === 0) return;
        if (shiftHeld) {
            moveSong(Math.sign(delta));
            return;
        }
        songMgmtCursor = Math.max(0, Math.min(songs.length, songMgmtCursor + Math.sign(delta)));
        return;
    }

    if (!pressed) return;

    if (moveControlNumber === moveBACK) {
        closeSongManagement();
    } else if (moveControlNumber === moveWHEEL) {
        if (songMgmtCursor === 0) {
            createSong();
            return;
        }
        activeSongId = songs[songMgmtCursor - 1].id;
        activePageIndex = 0;
        cachedSongId = null;     /* different song, different page shape */
        markSongsDirty();
        closeSongManagementToPerform();   /* relights the preset LEDs on the way out */
    } else if (moveControlNumber === moveCAP) {
        createSong();
    } else if (moveControlNumber === moveMENU) {
        if (songMgmtCursor > 0) renameSong(songs[songMgmtCursor - 1]);
    } else if (moveControlNumber === MoveDelete && shiftHeld) {
        if (songMgmtCursor > 0) deleteSong(songMgmtCursor - 1);
    }
}

function drawSongMgmt() {
    if (isTextEntryActive()) {
        tickTextEntry();
        drawTextEntry();
        return;
    }
    clear_screen();
    drawMenuHeader("Songs");
    drawMenuList({
        items: songMgmtItems(),
        selectedIndex: songMgmtCursor,
        getLabel: (item) => item.name,
        getValue: (item) => (item === ADD_SONG_ITEM ? "" : (item.id === activeSongId ? "*" : "")),
    });
    drawMenuFooter(["Jog: Move", "Shift+Jog: Reorder", "Click: Select"]);
}

/* ============================================================================
 * Knob Select - a cursor over the eight slots of the current page.
 *
 * Reached with a plain jogwheel click, which had nothing to do once
 * switching grid halves moved to the mode buttons. The wheel walks the
 * cursor, a second click opens whatever the slot holds, and Back
 * leaves. It replaces Shift+touch as the way into Knob Settings, which
 * is what freed Shift to be the audition.
 *
 * An EMPTY slot is a valid stop rather than something to skip: clicking
 * one opens the Add Knob wizard, exactly as Shift+touch on an empty
 * slot used to. Skipping them would make an empty page unreachable.
 * ============================================================================ */

let knobSelectOpen = false;
let knobSelectIndex = 0;

function openKnobSelect() {
    knobSelectOpen = true;
    /* Start on the first slot that HAS something, so the common case -
     * one knob on the page - needs no scrolling at all. Falls back to
     * slot 0 on an empty page, which is then the Add Knob door. */
    const page = getActivePage();
    const first = page ? page.knobs.findIndex((k) => k) : -1;
    knobSelectIndex = first >= 0 ? first : 0;
}

function closeKnobSelect() {
    knobSelectOpen = false;
}

/* Returns true when the cursor has taken the message. Unlike the menu
 * screens this is only an OVERLAY on the song page - the pads, the mode
 * buttons and the knobs all still mean what they usually do - so it
 * claims just the three controls it drives (wheel turn, wheel click,
 * Back) and lets everything else through to the normal handler. */
function handleKnobSelectInput(data) {
    if (data[0] !== 0xb0) return false;
    const control = data[1];
    const pressed = data[2] === 127;

    if (control === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta === 0) return true;
        knobSelectIndex = Math.max(0, Math.min(KNOBS_PER_PAGE - 1,
                                               knobSelectIndex + Math.sign(delta)));
        return true;
    }

    if (control !== moveBACK && control !== moveWHEEL) return false;
    if (!pressed) return true;          /* the release of one we took */

    if (control === moveBACK) {
        closeKnobSelect();
        return true;
    }

    const page = getActivePage();
    const slot = knobSelectIndex;
    closeKnobSelect();
    if (page) {
        if (page.knobs[slot]) openKnobEdit(slot);
        else openKnobWizard({ pageIndex: activePageIndex, slot });
    }
    return true;
}

/* ============================================================================
 * Knob Settings screen - Shift+touch a knob (notes 0-7) to open it, Back to
 * close. Drawn with the same drawMenuHeader/drawMenuList/drawMenuFooter chrome
 * as Song Management below, rather than the param-page dial/bar widgets, so
 * every settings-style screen in this module looks and drives the same way.
 *
 * Jog wheel moves the row cursor across the four fields (Name/CC/Mode/
 * Display); jog click on Name dives straight into text_entry.mjs (an opaque
 * field has no turn behaviour, matching "a knob that cannot turn opens on
 * touch" elsewhere in Schwung); jog click on any other row toggles it
 * "entered" - drawMenuList's own `editMode` affordance, which brackets the
 * selected row's value - and while entered, jog turn steps that field's value
 * instead of moving the cursor (an enum is just an int clamped to
 * [0, options.length-1], so the same clamp logic drives Mode and Display).
 * Touching a DIFFERENT knob (notes 0-7) while this screen is already open
 * switches straight to editing that one, without Back+Shift+touch again - the
 * plain (un-shifted) touch is unambiguous here since the screen already owns
 * every knob touch and there's nothing else it could mean.
 * Same screen-ownership shape as Song Management otherwise - suspends LPP
 * forwarding, resyncs the pads on close.
 * ============================================================================ */

/* "add" and "remove" are ACTION rows, not values: they never enter edit
 * mode, they fire on click. Kept in the same list so the jog walks them
 * like any other row rather than needing a second gesture to reach.
 *
 * "add" is here as well as on an empty slot because a FULL page has no
 * empty slot left to touch - that is the case auto-page-creation exists
 * for, and without a second door it would be unreachable. */
const KNOB_SETTINGS_FIELDS = ["name", "connect", "cc", "mode", "display", "move", "add", "remove"];
const KNOB_SETTINGS_LABELS = {
    name: "Name", connect: "Connect", cc: "CC", mode: "Mode", display: "Display",
    move: "Slot", add: "Add Knob", remove: "Remove Knob",
};

let knobEditOpen = false;
let knobEditIndex = -1;
let knobEditCursor = 0;
let knobEditEntered = false;

function openKnobEdit(index) {
    const page = getActivePage();
    if (!page || !page.knobs[index]) return; /* nothing there to edit */
    knobEditOpen = true;
    knobEditIndex = index;
    knobEditCursor = 0;
    knobEditEntered = false;
}

function closeKnobEdit() {
    knobEditOpen = false;
    knobEditIndex = -1;
    /* A knob's display mode may have just changed, which changes the SHAPE
     * of the main page's synthetic chain_params (plain int vs the hex-enum
     * trick) - force ensureSongPageMeta to rebuild instead of serving the
     * pre-edit cache. */
    cachedSongId = null;
    queuePadRedraw();
    updateMoveViewPulse();
}

/* The slots a move operates on: the whole viz group if this knob is in
 * one, otherwise just this knob.
 *
 * A graphic's members have to stay contiguous AND inside one row or
 * viz.mjs stops forming the group and the picture disappears, so moving a
 * single member out from under its own graphic is never what was wanted.
 * The group travels as a block instead. */
function knobMoveBlock(page, index) {
    const knob = page.knobs[index];
    const group = knob && knob.viz ? knob.viz.group : null;
    if (!group) return { start: index, size: 1 };
    const slots = [];
    page.knobs.forEach((k, i) => {
        if (k && k.viz && k.viz.group === group) slots.push(i);
    });
    const start = Math.min(...slots);
    return { start, size: Math.max(...slots) - start + 1 };
}

/* Where a block of this size may begin: anywhere it fits within a SINGLE
 * row. That is viz.mjs's constraint, and it is what makes a four-knob
 * envelope have exactly two possible homes (the two rows) while a lone
 * knob can sit anywhere. */
function validBlockStarts(size) {
    const out = [];
    for (let base = 0; base < KNOBS_PER_PAGE; base += KNOBS_PER_ROW) {
        for (let start = base; start + size <= base + KNOBS_PER_ROW; start++) out.push(start);
    }
    return out;
}

/* Move the edited knob - or its whole graphic - to the next valid
 * position, swapping with whatever is in the way so nothing is displaced
 * off the page. Within the current page only: a slot IS a physical
 * encoder, and moving a knob to a page you are not looking at would put
 * it under no encoder at all. Knobs keep their names, CCs and values;
 * only their positions change.
 *
 * Because the step is "next VALID start" rather than "one slot", a block
 * that cannot slide within its row jumps to the other row instead - which
 * is the only way a four-knob envelope can be moved at all. */
function moveKnobSlot(step) {
    const page = getActivePage();
    if (!page) return;
    const knobs = page.knobs;
    const { start, size } = knobMoveBlock(page, knobEditIndex);

    const starts = validBlockStarts(size);
    const target = starts[starts.indexOf(start) + step];
    if (target === undefined) return;

    const moving = knobs.slice(start, start + size);
    /* Whatever occupies the destination and is not part of the block
     * itself comes back to fill the slots the block vacates. The two
     * counts always match, so no knob is created or lost: a step within a
     * row rotates its neighbour around, and a jump to the other row swaps
     * the two blocks whole. */
    const displaced = [];
    for (let i = target; i < target + size; i++) {
        if (i >= start && i < start + size) continue;
        if (knobs[i]) displaced.push(knobs[i]);
    }
    const freed = [];
    for (let i = start; i < start + size; i++) {
        if (i < target || i >= target + size) freed.push(i);
    }

    for (let i = start; i < start + size; i++) knobs[i] = null;
    for (let i = target; i < target + size; i++) knobs[i] = null;
    moving.forEach((k, i) => { knobs[target + i] = k; });
    displaced.forEach((k, i) => { if (freed[i] !== undefined) knobs[freed[i]] = k; });

    knobEditIndex += target - start;   /* keep editing the knob, not the slot */
    cachedSongId = null;               /* slot -> key mapping changed */
}

function renameKnob(knob) {
    openTextEntry({
        title: "Rename Knob",
        initialText: knob.name,
        onConfirm: (text) => {
            const trimmed = (text || "").trim();
            if (trimmed) knob.name = trimmed;
            markSongsDirty();
        },
    });
}

function handleKnobEditInput(data) {
    if (routeTextEntryInput(data)) return;

    const page = getActivePage();
    const knob = page ? page.knobs[knobEditIndex] : null;
    if (!knob) {
        closeKnobEdit();
        return;
    }

    /* Touching a different knob (notes 0-7) while this screen is open jumps
     * straight to editing that one instead - no need to Back out and
     * Shift+touch again. Resets the row cursor and drops out of "entered" so
     * the new knob always opens on Name, matching a fresh Shift+touch open. */
    if (data[0] === 0x90 && data[2] === 127 && data[1] >= 0 && data[1] <= 7) {
        /* Only onto a slot that HAS a knob - an empty one has no settings
         * to show, and silently doing nothing is better than opening a
         * blank screen the Back key then has to be used to escape. */
        if (data[1] !== knobEditIndex && page.knobs[data[1]]) {
            knobEditIndex = data[1];
            knobEditCursor = 0;
            knobEditEntered = false;
        }
        return;
    }

    if (data[0] !== 0xb0) return;

    const moveControlNumber = data[1];
    const pressed = data[2] === 127;

    if (moveControlNumber === moveSHIFT) {
        shiftHeld = pressed;
        return;
    }

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta === 0) return;
        if (!knobEditEntered) {
            knobEditCursor = Math.max(0, Math.min(KNOB_SETTINGS_FIELDS.length - 1, knobEditCursor + Math.sign(delta)));
            return;
        }
        const field = KNOB_SETTINGS_FIELDS[knobEditCursor];
        if (field === "cc") {
            knob.cc = Math.max(1, Math.min(127, knob.cc + Math.sign(delta)));
        } else if (field === "mode") {
            knob.mode = Math.max(0, Math.min(KNOB_MODE_OPTIONS.length - 1, knob.mode + Math.sign(delta)));
        } else if (field === "display") {
            knob.display = Math.max(0, Math.min(KNOB_DISPLAY_OPTIONS.length - 1, knob.display + Math.sign(delta)));
        } else if (field === "move") {
            moveKnobSlot(Math.sign(delta));
        }
        markSongsDirty();
        return;
    }

    if (!pressed) return;

    if (moveControlNumber === moveBACK) {
        closeKnobEdit();
    } else if (moveControlNumber === moveWHEEL) {
        const field = KNOB_SETTINGS_FIELDS[knobEditCursor];
        if (field === "name") {
            renameKnob(knob);
            return;
        }
        if (field === "connect") {
            const index = knobEditIndex;
            closeKnobEdit();
            /* Same wizard, same catalogue - it re-points this knob at the
             * leaf instead of making a new one, and comes back here. */
            openKnobWizard(null, index);
            return;
        }
        if (field === "add") {
            closeKnobEdit();
            /* No target: placement is worked out when the leaf is chosen,
             * because only then is it known how many slots it needs.
             * nextFreeKnobRun appends a page if there is no room, which is
             * the "this page is full" path this row exists for. */
            openKnobWizard(null);
            return;
        }
        if (field === "remove") {
            const song = getActiveSong();
            if (song) removeKnobAt(song, activePageIndex, knobEditIndex);
            closeKnobEdit();
            return;
        }
        knobEditEntered = !knobEditEntered;
    }
}

function drawKnobEdit() {
    if (isTextEntryActive()) {
        tickTextEntry();
        drawTextEntry();
        return;
    }

    const page = getActivePage();
    const knob = page ? page.knobs[knobEditIndex] : null;
    if (!knob) {
        closeKnobEdit();
        return;
    }

    clear_screen();
    drawMenuHeader(`Knob ${knobEditIndex + 1}`);
    drawMenuList({
        items: KNOB_SETTINGS_FIELDS,
        selectedIndex: knobEditCursor,
        editMode: knobEditEntered,
        getLabel: (field) => KNOB_SETTINGS_LABELS[field],
        getValue: (field) => {
            if (field === "name") return knob.name;
            /* The RECORDED connection, never the one derived from the
             * name. A dash means the header cannot say which instrument
             * this knob belongs to, which is the whole reason to come
             * here - so a guess in this column would hide the knobs that
             * need the row. */
            if (field === "connect") return knob.detail ? shortLabel(knob.detail) : "-";
            if (field === "cc") return String(knob.cc);
            if (field === "mode") return KNOB_MODE_OPTIONS[knob.mode];
            if (field === "display") return KNOB_DISPLAY_OPTIONS[knob.display];
            if (field === "move") {
                /* A range when a graphic moves as one, so the row says
                 * that the whole picture travels rather than this knob. */
                const block = knobMoveBlock(page, knobEditIndex);
                return block.size > 1
                    ? `${block.start + 1}-${block.start + block.size}`
                    : String(knobEditIndex + 1);
            }
            return "";
        },
    });
    drawMenuFooter(["Jog: Move", "Click: Edit", "Back: Close"]);
}

/* ============================================================================
 * Add Knob wizard - Shift+touch an EMPTY knob slot, or the Add Knob row in
 * Knob Settings.
 *
 * A STACK of screens rather than numbered steps. The paths are different
 * lengths - Mixer is two screens, an instrument mod is five - and a stack
 * makes Back mean one thing everywhere (pop; close when empty) instead of
 * each screen having to know its own depth.
 *
 * A frame is either a LIST (drawMenuList, same chrome as every other menu
 * here) or the two-digit HEX editor used for the instrument number, which
 * is a list of its own in the Knob Settings idiom: jog moves between the
 * digits, click enters and leaves a digit, and an Add/Next row commits.
 * 128 instruments as a flat list would be a long scroll to reach 7F.
 * ============================================================================ */

const WIZ_LIST = "list";
const WIZ_HEX = "hex";

let knobWizardOpen = false;
/* Frames: { kind, title, items, getLabel, getValue, onPick } for a list, or
 * { kind: WIZ_HEX, title, value, onPick } for the number editor. Each frame
 * carries its own cursor so popping back lands where it was left. */
let knobWizardStack = [];
/* Where the knob will land. Captured at open (the empty slot that was
 * touched), or null when the wizard was opened from Knob Settings and the
 * placement should be worked out at commit time. */
let knobWizardTarget = null;
/* The instrument number chosen at the top of the Instrument path, carried
 * down to whichever leaf finally commits. */
let knobWizardInstrument = 0;

/* >= 0 while the wizard is re-pointing an EXISTING knob rather than
 * making a new one: the slot on the active page whose Connect row opened
 * it. The two walks are the same catalogue and the same frames - only
 * what happens at the leaf differs - so a second wizard would have been
 * the same code with one line changed. */
let knobWizardConnect = -1;

function openKnobWizard(target, connectIndex) {
    knobWizardOpen = true;
    knobWizardTarget = target || null;
    knobWizardConnect = connectIndex === undefined ? -1 : connectIndex;
    knobWizardInstrument = 0;
    knobWizardStack = [];
    pushWizardFrame(rootWizardFrame());
}

function closeKnobWizard() {
    knobWizardOpen = false;
    knobWizardConnect = -1;
    knobWizardStack = [];
    cachedSongId = null; /* the page's shape may have changed - rebuild the meta */
    queuePadRedraw();
    updateMoveViewPulse();
}

/* Each frame carries the CONTEXT the path has narrowed to so far - "MIX",
 * "REV", "I1A", "I1A M2" - inherited from its parent unless it narrows
 * further. It ends up on the knob as `detail` and is what the header
 * shows while the knob is touched, because a name like CUT1A says which
 * instrument only if you already know the scheme.
 *
 * Kept on the FRAME rather than in one variable so Back unwinds it for
 * free: popping to the parent restores the parent's context. */
function pushWizardFrame(frame) {
    if (!frame) return;
    frame.cursor = 0;
    if (frame.kind === WIZ_HEX) frame.editing = -1;
    if (frame.ctx === undefined) {
        const parent = currentWizardFrame();
        frame.ctx = parent ? parent.ctx : "";
    }
    knobWizardStack.push(frame);
}

function currentWizardFrame() {
    return knobWizardStack[knobWizardStack.length - 1] || null;
}

/* The innermost frame that HAS a context, not the innermost frame.
 * The last step before a commit is often a plain picker that carries none
 * - the track number for Mixer > Track Volume, the wave for an LFO - so
 * reading the top of the stack dropped the context for exactly the entries
 * that take an extra step, and did it silently. */
function wizardCtx() {
    for (let i = knobWizardStack.length - 1; i >= 0; i--) {
        const ctx = knobWizardStack[i].ctx;
        if (ctx) return ctx;
    }
    return "";
}

/* Commit a catalogue leaf and close. `number` is what gets appended to the
 * name - a track, an instrument, or a mod slot, depending on the path. */
function commitWizardEntry(entry, number, vizMode) {
    const song = getActiveSong();
    if (song) {
        /* "Ins1A Cutoff", "MIX Track Volume", "Ins1A M2 Attack" - what the
         * header spells out while the knob is touched, abbreviated on the
         * way to the screen by knobDetail. The 3-letter stem under the
         * dial cannot say which instrument or which mod slot, and that is
         * the thing worth knowing. */
        if (knobWizardConnect >= 0) {
            const index = knobWizardConnect;
            connectKnobsFromEntry(song, entry, number, vizMode, wizardCtx(), index);
            closeKnobWizard();
            /* Straight back to the row that asked, so the new name and
             * connection are visible where the change was made. */
            openKnobEdit(index);
            return;
        }
        addKnobsFromEntry(song, entry, number, knobWizardTarget, vizMode, wizardCtx());
    }
    closeKnobWizard();
}

/* A graphic whose shape is fixed by a selector needs that selector's value
 * before it can be drawn, and the selector is not mappable so it never
 * becomes a knob - so the wizard asks, as one more step, and the answer is
 * stored with the group. Entries without one commit straight away. */
function pickEntry(entry, number) {
    /* A Generic shape IS its mode - "LFO SIN" was the row that was
     * clicked - so there is nothing left to ask. */
    if (entry.fixedVizMode) {
        commitWizardEntry(entry, number, entry.fixedVizMode);
        return;
    }
    if (!entry.vizModeOptions) {
        commitWizardEntry(entry, number);
        return;
    }
    pushWizardFrame(listFrame(
        entry.vizModePrompt || "Type", entry.vizModeOptions,
        (opt) => opt,
        () => "",
        (opt) => commitWizardEntry(entry, number, opt)));
}

/* --------------------------------------------------------- wizard frames */

function listFrame(title, items, getLabel, getValue, onPick, ctx) {
    return { kind: WIZ_LIST, title, items, getLabel, getValue, onPick, ctx };
}

/* A catalogue leaf's right-hand column: the name the knob will end up with,
 * so the result is visible before it is chosen. A multi-knob entry shows how
 * many knobs it will take instead - its members have several names. */
function entryPreview(entry, number) {
    if (entry.knobs) return `${entry.knobs.length}kn`;
    if (entry.needsTrack && number === undefined) return `${entry.m}..`;
    return m8KnobName(entry.m, number);
}

function paramListFrame(title, params, number, ctx) {
    return listFrame(
        title, params,
        (p) => p.label,
        (p) => entryPreview(p, number),
        (p) => {
            /* Only the mixer's track volume still asks for a number of its
             * own; everything else was numbered further up the path. */
            if (p.needsTrack) {
                pushWizardFrame(listFrame(
                    p.label, [1, 2, 3, 4, 5, 6, 7, 8],
                    (t) => `Track ${t}`,
                    (t) => m8KnobName(p.m, t),
                    (t) => pickEntry(p, t)));
                return;
            }
            pickEntry(p, number);
        },
        ctx);
}

/* The root's first entry: everything that does not need to be told which
 * instrument it belongs to.
 *
 * "Knob" is the old "Other" - a knob the catalogue has no opinion about,
 * which you name yourself and which takes the next free CC like any other.
 * It sat alone at the BOTTOM of the root list, which is the wrong end for
 * the entry a new user reaches for first.
 *
 * The mod types are here for a reason rather than for convenience: a mod
 * parameter is named and numbered by its SLOT, so the instrument step
 * above them was two clicks that changed nothing about the resulting
 * knob. Instrument > Mods still exists for the one thing it does add,
 * which is recording the instrument for the header. */
function genericFrame() {
    const entries = [{ name: "Knob", entry: null }];
    for (const e of M8_GENERIC_SHAPES) entries.push({ name: e.label, entry: e });
    /* One level, and it commits: no instrument, no mod slot, no track.
     * Everything here is chosen by its picture and connected afterwards
     * from Knob Settings, which is the whole point of the list. */
    return listFrame(
        "Generic", entries,
        (e) => e.name,
        (e) => (e.entry ? `${entryMembers(e.entry).length}kn` : ""),
        (e) => (e.entry ? pickEntry(e.entry, null) : openOtherKnobEntry()));
}

function rootWizardFrame() {
    const groups = [
        { name: "Generic", open: () => pushWizardFrame(genericFrame()) },
        {
            name: "Instrument",
            open: () => pushWizardFrame({
                kind: WIZ_HEX, title: "Instrument", value: 0,
                onPick: (n) => { knobWizardInstrument = n; pushWizardFrame(instrumentFrame(n)); },
                ctx: "",
            }),
        },
        { name: "Mixer", open: () => pushWizardFrame(paramListFrame("Mixer", M8_MIXER_PARAMS, undefined, "MIX")) },
        {
            name: "Sends",
            open: () => pushWizardFrame(listFrame(
                "Sends", M8_SEND_GROUPS,
                (g) => g.name,
                (g) => String(g.params.length),
                (g) => pushWizardFrame(paramListFrame(g.name, g.params, undefined, g.ctx)))),
        },
    ];
    return listFrame("Add Knob", groups, (g) => g.name, () => "", (g) => g.open());
}

/* A mod parameter's NAME is numbered by its slot ("ATK2"), so the
 * instrument is the one thing about it the name can never say - which is
 * exactly why this path records it in the context and why there is no
 * instrument-free shortcut to it. Generic offers the mod GRAPHICS with no
 * connection at all; naming one is always this walk. */
function modSlotFrame(ctx) {
    return listFrame(
        "Mod Slot", [1, 2, 3, 4],
        (n) => `Mod ${n}`,
        () => "",
        (n) => {
            const slotCtx = [ctx, `M${n}`].filter(Boolean).join(" ");
            pushWizardFrame(listFrame(
                `Mod ${n}`, M8_MOD_TYPES,
                (t) => t.name,
                () => "",
                (t) => pushWizardFrame(paramListFrame(t.name, t.params, n, slotCtx)),
                slotCtx));
        },
        ctx);
}

function instrumentFrame(instrument) {
    const label = instrument.toString(16).toUpperCase().padStart(2, "0");
    const ctx = instCtx(instrument);
    const categories = [
        /* "Base": the parameters every instrument has, whatever its type.
         * It was "Generic", which now names the root's no-connection
         * shape list - two different things one level apart under the
         * same word. */
        {
            name: "Base",
            open: () => pushWizardFrame(
                paramListFrame("Base", M8_INSTRUMENT_GENERIC, instrument, ctx)),
        },
        /* The mod SLOT, not the instrument, numbers a mod parameter's
         * name - see m8KnobName. */
        { name: "Mods", open: () => pushWizardFrame(modSlotFrame(ctx)) },
        {
            name: "Instrument Type",
            open: () => pushWizardFrame(listFrame(
                "Type", M8_INSTRUMENT_TYPES,
                (t) => t.name,
                (t) => String(t.params.length),
                (t) => pushWizardFrame(
                    paramListFrame(t.name, typeParamsFor(t), instrument, ctx)))),
        },
    ];
    return listFrame(`Inst ${label}`, categories, (c) => c.name, () => "", (c) => c.open(), ctx);
}

/* A type's own parameters, plus its filter graphic when the type widens the
 * filter list - Wavsynth's four in-waveform modes are not offered anywhere
 * else, so its filter entry cannot come from the shared generic list. */
function typeParamsFor(type) {
    if (!type.filterTypes) return type.params;
    return [filterEntry(type.filterTypes)].concat(type.params);
}

/* Generic > Knob: straight to the keyboard, and the typed text IS the
 * name. For an M8 parameter this module does not know, or a mapping to
 * something else entirely on the same channel. */
function openOtherKnobEntry() {
    openTextEntry({
        title: "Knob Name",
        initialText: "PRM",
        onConfirm: (text) => {
            const trimmed = (text || "").trim();
            commitWizardEntry({ m: trimmed || "PRM", def: 0x00 }, null);
        },
    });
}

/* ---------------------------------------------------------- wizard input */

function handleKnobWizardInput(data) {
    /* Generic > Knob hands the pads to text_entry.mjs; it owns everything until it
     * confirms or cancels. A cancel leaves the wizard standing on the group
     * list, which is where Back would have put it anyway. */
    if (routeTextEntryInput(data)) return;
    if (data[0] !== 0xb0) return;

    const frame = currentWizardFrame();
    if (!frame) {
        closeKnobWizard();
        return;
    }

    const moveControlNumber = data[1];
    const pressed = data[2] === 127;

    if (moveControlNumber === moveSHIFT) {
        shiftHeld = pressed;
        return;
    }

    if (moveControlNumber === moveJogTurn) {
        const delta = decodeDelta(data[2]);
        if (delta !== 0) wizardTurn(frame, Math.sign(delta));
        return;
    }

    if (!pressed) return;

    if (moveControlNumber === moveBACK) {
        if (frame.kind === WIZ_HEX && frame.editing >= 0) {
            frame.editing = -1;   /* leave the digit before leaving the screen */
            return;
        }
        knobWizardStack.pop();
        if (!knobWizardStack.length) closeKnobWizard();
        return;
    }

    if (moveControlNumber === moveWHEEL) wizardClick(frame);
}

/* Rows of the hex editor: the two digits, then the row that accepts. */
const WIZ_HEX_ROWS = 3;

function wizardTurn(frame, step) {
    if (frame.kind === WIZ_HEX) {
        if (frame.editing < 0) {
            frame.cursor = Math.max(0, Math.min(WIZ_HEX_ROWS - 1, frame.cursor + step));
            return;
        }
        /* Editing a digit: each digit is clamped to 0-F on its own and never
         * carries into the other, which is the whole reason for editing them
         * separately - winding the low digit past F to reach the next
         * sixteen is the scroll this screen exists to avoid. */
        const digit = frame.editing === 0 ? (frame.value >> 4) & 0xF : frame.value & 0xF;
        const next = Math.max(0, Math.min(15, digit + step));
        frame.value = frame.editing === 0
            ? (next << 4) | (frame.value & 0xF)
            : (frame.value & 0xF0) | next;
        return;
    }
    frame.cursor = Math.max(0, Math.min(frame.items.length - 1, frame.cursor + step));
}

function wizardClick(frame) {
    if (frame.kind === WIZ_HEX) {
        if (frame.cursor === WIZ_HEX_ROWS - 1) {
            frame.onPick(frame.value);
            return;
        }
        frame.editing = frame.editing === frame.cursor ? -1 : frame.cursor;
        return;
    }
    const chosen = frame.items[frame.cursor];
    if (chosen !== undefined) frame.onPick(chosen);
}

/* ---------------------------------------------------------- wizard draw */

function drawKnobWizard() {
    const frame = currentWizardFrame();
    if (!frame) {
        closeKnobWizard();
        return;
    }
    if (isTextEntryActive()) {
        tickTextEntry();
        drawTextEntry();
        return;
    }

    clear_screen();
    if (frame.kind === WIZ_HEX) {
        drawWizardHex(frame);
        return;
    }
    drawMenuHeader(frame.title);
    drawMenuList({
        items: frame.items,
        selectedIndex: frame.cursor,
        /* This list carries the longest labels in the module - "Filter
         * Highpass", "LFO Square Down" - against the shortest values,
         * which are all "2kn". The default columns are laid out for the
         * opposite shape (a 9px indent and a value column starting at
         * 92), which left 12 characters for a 15-character label and
         * ran it into the value.
         *
         * Both edges move: dropping the indent alone still leaves the
         * longest rows a character short. */
        labelX: 2,
        valueX: 104,
        getLabel: (item) => frame.getLabel(item),
        getValue: (item) => frame.getValue(item),
    });
    drawMenuFooter(["Jog: Move", "Click: Pick", "Back: Up"]);
}

function drawWizardHex(frame) {
    const hex = frame.value.toString(16).toUpperCase().padStart(2, "0");
    drawMenuHeader(`${frame.title} ${hex}`);
    drawMenuList({
        items: [0, 1, 2],
        selectedIndex: frame.cursor,
        editMode: frame.editing >= 0 && frame.editing === frame.cursor,
        getLabel: (row) => (row === 0 ? "Digit 1" : row === 1 ? "Digit 2" : "Use This"),
        getValue: (row) => {
            if (row === 0) return hex[0];
            if (row === 1) return hex[1];
            return hex;
        },
    });
    drawMenuFooter(["Jog: Move", "Click: Edit", "Back: Up"]);
}

/* Adapter from param_pages' { fillRect, print, textWidth } contract to
 * Move's actual globals, which are snake_case (fill_rect/text_width) except
 * print, which already matches. */
const songPageDrawCtx = {
    fillRect: (x, y, w, h, color) => fill_rect(x, y, w, h, color),
    print: (x, y, text, color) => print(x, y, text, color),
    textWidth: (text) => text_width(text),
};

/* Cached per (song, page) so the synthetic chain_params/metaIndex aren't
 * rebuilt every tick (~245Hz, measured earlier in this module's debugging) -
 * only when the active song or page actually changes. Matches the
 * "rebuild when fingerprint changes" pattern docs/PARAM_PAGES.md describes
 * for the real chain-slot case. */
let cachedSongId = null;
let cachedPageIndex = -1;
let cachedChainParams = null;
let cachedMetaIndex = null;
/* Cell-less params carrying each graphic's fixed setting - see the
 * `span: false` note in ensureSongPageMeta. */
let cachedVizModeParams = [];

/* Every knob is declared "int" now, always - see the note above HEX_OPTIONS'
 * old home in git history for why an enum-of-hex-strings was tried instead.
 * That got the hex TEXT right but lost the dial pointer: render_page.mjs
 * only draws the dial for a KIND_NUMBER cell (drawCell's KIND_ENUM branch
 * draws a boxed value, no dial) - so a Hex-display knob rendered as a static
 * box while its Decimal-display neighbours kept their needle. Declaring
 * every knob "int" restores the dial (the fraction it points to comes from
 * the plain 0-127 CC value either way, so the pointer is correct regardless
 * of display mode) and the cell's own label position is left showing the
 * knob's NAME always - the VALUE, hex or decimal, is never drawn on the
 * cell at all, only in the swapped title row drawSongPage builds below. */
function ensureSongPageMeta(song, pageIndex, page) {
    if (cachedSongId === song.id && cachedPageIndex === pageIndex) return;
    /* chain_params spells the display label `name`, not `label` - that's the
     * inline-hierarchy field name, and using the wrong one silently falls
     * through to a de-underscored key instead of throwing.
     *
     * An empty slot contributes a null rather than a param: renderPage draws
     * a faint tick for any slot whose key is falsy (drawEmptyCell), which is
     * exactly what an addable slot should look like, so the holes need no
     * handling of their own beyond keeping the array 8 long and positional. */
    /* A graphic needs at least two of its knobs still present. viz.mjs is
     * happy to form a one-role group (a single slot IS an adjacent run), and
     * drawEnvelope then returns without drawing anything - leaving a cell
     * that is claimed by the graphic and therefore skipped by the ordinary
     * cell loop, i.e. blank. Removing two of an envelope's three knobs is
     * all it takes. Counting first and dropping the declaration below turns
     * that case back into ordinary dials. */
    const groupCounts = new Map();
    for (const k of page.knobs) {
        if (!k || !k.viz || !k.viz.group) continue;
        groupCounts.set(k.viz.group, (groupCounts.get(k.viz.group) || 0) + 1);
    }

    /* Groups whose fixed setting has no honest picture - see
     * vizModeUnsupported. Declaring no viz leaves the members as
     * ordinary labelled dials. */
    const unsupported = new Set();
    for (const k of page.knobs) {
        if (!k || !k.viz || !k.viz.group || !k.vizMode) continue;
        if (vizModeUnsupported(k.vizMode)) unsupported.add(k.viz.group);
    }

    cachedChainParams = page.knobs.map((k, i) => {
        if (!k) return null;
        const key = `${song.id}:${pageIndex}:${i}`;
        const param = { key, name: k.name, type: "int", min: 0, max: 127, step: 1 };
        if (k.viz && k.viz.group && groupCounts.get(k.viz.group) >= 2
            && !unsupported.has(k.viz.group)) {
            param.viz = { group: k.viz.group, kind: k.viz.kind, role: k.viz.role };
        }
        return param;
    });

    /* The fixed setting behind a graphic - a filter's type, an LFO's wave -
     * as a role with NO CELL. viz.mjs's `span: false` is exactly this: "a
     * role that lends the graphic its VALUE without joining the run of
     * cells it covers", and such a role is not claimed, so it costs no
     * slot. The key is appended PAST the eight the grid draws, so
     * renderPage's cell loop (which stops at COLS*ROWS) never reaches it
     * while collectDeclared, which walks the whole key array, still sees
     * it.
     *
     * The value is always index 0 of a one-option enum holding the chosen
     * text, because the only consumer is viz_draw resolving that text to a
     * curve or a wave - it never needs the other options, and keeping the
     * full list out of the saved song keeps songs.json small. */
    cachedVizModeParams = [];
    page.knobs.forEach((k, i) => {
        if (!k || !k.vizMode || !k.viz || !k.viz.group) return;
        if (groupCounts.get(k.viz.group) < 2) return;
        if (unsupported.has(k.viz.group)) return;
        cachedVizModeParams.push({
            key: `${song.id}:${pageIndex}:${i}:mode`,
            name: "",
            type: "enum",
            options: [k.vizMode],
            viz: {
                group: k.viz.group,
                kind: k.viz.kind,
                role: k.viz.kind === "lfo" ? "shape" : "mode",
                span: false,
            },
        });
    });

    cachedMetaIndex = buildMetaIndex({
        chainParams: cachedChainParams.filter(Boolean).concat(cachedVizModeParams),
    });
    cachedSongId = song.id;
    cachedPageIndex = pageIndex;
}

/* Where the library draws a cell's name label.
 *
 * render_page.mjs derives this from constants it does not export
 * (HEADER_BLOCK, FONT_H and the row height), so the two baselines are
 * pinned here instead - and CHECKED: test_graphic_labels asserts that an
 * ordinary dial's label lands exactly on them, so a change in that file
 * fails a test rather than quietly putting text in the wrong place.
 *
 * This replaced a scheme that wrapped `print` and matched the recorded
 * calls by position. That worked for a labelled cell and could not work
 * at all for a cell covered by a graphic, which prints nothing - and
 * those are exactly the cells that now need a label drawn. */
const CELL_LABEL_Y = [30, 56];
const CELL_W = SCREEN_WIDTH / COLS;

function slotLabelCentre(slot) {
    return (slot % KNOBS_PER_ROW) * CELL_W + Math.floor(CELL_W / 2);
}

function slotLabelBaseline(slot) {
    return CELL_LABEL_Y[Math.floor(slot / KNOBS_PER_ROW)];
}

/* Draw one cell's label row: a name, or a value in an inverted pill.
 *
 * The full cell width is cleared first whatever is being drawn, because
 * what is already there may be WIDER than what replaces it - "CUTOFF"
 * giving way to "E0" would otherwise leave the ends of the old name
 * showing on either side of the pill.
 *
 * The pill itself is only as wide as its text plus a couple of pixels,
 * rather than the whole cell: a full-width bar reads as a highlighted
 * row, and what is wanted is a badge around the number. */
/* THE LAST PIXEL ROW OF THE PANEL IS NOT SAFE TO PAINT.
 *
 * The bottom cell's label row is y 55 to 63 - exactly the full height -
 * and a pill drawn there came out on the device as a white line across
 * the TOP of the screen as well, at the same x. Nothing in the module
 * or the host renderer draws it (both clip at the buffer edge, and the
 * draw log has nothing above y=8 at that x), so it is the panel's own
 * row 63 showing up where it should not. Everything else on this
 * surface stops at 62 - the footer text included - which is why this
 * is the first place it has ever shown.
 *
 * So the label row is trimmed to end at 62 where it would run to 63.
 * One pixel off the bottom of a nine-pixel pill is not visible; the
 * line at the top very much is. */
const LAST_SAFE_ROW = 62;

function labelRowHeight(top) {
    return Math.min(LABEL_ROW_H, LAST_SAFE_ROW + 1 - top);
}

function drawSlotLabel(slot, text, inverted) {
    const cx = slotLabelCentre(slot);
    const y = slotLabelBaseline(slot);
    const rowTop = y - 1;
    const rowH = labelRowHeight(rowTop);
    fill_rect(Math.round(cx - CELL_W / 2), rowTop, CELL_W, rowH, 0);
    const fitted = fitText(songPageDrawCtx, text, CELL_W - 2);
    if (inverted) {
        /* The pill hugs the text, so it can be WIDER than the cell -
         * the text is fitted to CELL_W - 2 and the pill adds four for
         * its padding. In the last cell that ran off the right edge
         * and fill_rect refused the write. Clamped to the panel. */
        const w = Math.min(text_width(fitted) + 4, SCREEN_WIDTH);
        const x = Math.max(0, Math.min(Math.round(cx - w / 2), SCREEN_WIDTH - w));
        fill_rect(x, rowTop, w, rowH, 1);
    }
    centeredText(songPageDrawCtx, cx, y, fitted, inverted ? 0 : 1);
}

/* The master knob's value, drawn OVER the page while it is moving.
 *
 * It cannot have a cell: the eight cells belong to the song knobs and
 * the master is not one of them. A panel in the middle borrows the
 * space instead and gives it straight back - the page underneath is
 * redrawn whole on the next frame, so nothing has to be restored. A
 * hollow box rather than a solid pill, so it reads as something laid on
 * top of the dials instead of one of them. */
const MASTER_OVERLAY_H = 17;

function drawMasterOverlay() {
    const label = "Main " + (settings.masterValue * 2).toString(16).toUpperCase().padStart(2, "0");
    const w = Math.min(SCREEN_WIDTH - 8, text_width(label) + 18);
    const x = Math.round((SCREEN_WIDTH - w) / 2);
    const y = 24;
    fill_rect(x, y, w, MASTER_OVERLAY_H, 1);
    fill_rect(x + 1, y + 1, w - 2, MASTER_OVERLAY_H - 2, 0);
    centeredText(songPageDrawCtx, SCREEN_WIDTH / 2, y + 5, label, 1);
}

/* Holding the jog wheel turns knob moves into an AUDITION: the values
 * you dial in while it is held are put back when you let go.
 *
 * This is the same bargain the wheel already strikes with the pad view -
 * hold to look, release to undo - so "nothing you do while holding the
 * wheel sticks" is one rule rather than two.
 *
 * The original value is captured lazily, on the first turn of each knob,
 * so holding the wheel without touching anything costs nothing. Reverting
 * has to reach M8 as well as the display, and how depends on the knob's
 * send mode - see revertAuditionedKnobs. */
const auditionedKnobs = new Map();   /* knob object -> value before the audition */

/* Held SHIFT is what makes a knob move an audition now. It used to be a
 * held wheel touch, and the wheel was needed back for knob select;
 * Shift came free the moment knob editing moved off Shift+touch. */
function noteAuditionValue(knob) {
    if (shiftHeld && !auditionedKnobs.has(knob)) auditionedKnobs.set(knob, knob.value);
}

function revertAuditionedKnobs() {
    revertMasterAudition();
    if (!auditionedKnobs.size) return;
    for (const [knob, original] of auditionedKnobs) {
        const delta = original - knob.value;
        knob.value = original;
        if (delta === 0) continue;
        if (knob.mode === KNOB_MODE_RELATIVE) {
            /* Relative knobs send movement, not position, so the revert
             * is the opposite movement. Move's encoding is 1-63 for
             * clockwise and 65-127 for anticlockwise (see decodeDelta),
             * and one message carries the whole correction. */
            const size = Math.min(63, Math.abs(delta));
            move_midi_external_send([2 << 4 | 0xb, 0xb0 | settings.knobChannel,
                                     knob.cc, delta > 0 ? size : 64 + size]);
        } else {
            move_midi_external_send([2 << 4 | 0xb, 0xb0 | settings.knobChannel,
                                     knob.cc, knob.value]);
        }
    }
    auditionedKnobs.clear();
    /* The autosave may well have persisted a mid-audition value already,
     * so the revert has to be written too. */
    markSongsDirty();
}

/* Which song knob (0-7, or -1) reads as "active" right now - its VALUE
 * replaces its own NAME label (the text under its dial), reverting to the
 * name once it isn't. A capacitive touch claims a knob until release; a turn
 * with no touch registered claims it for KNOB_TURN_CLAIM_MS instead, the
 * same shape as Schwung's own TURN_CLAIM_MS in page_controller.mjs - a turn
 * has no release event of its own, so it has to time out rather than latch
 * forever on a knob whose touch pad never fired. See claimKnobTouch/
 * releaseKnobTouch/claimKnobTurn and their call sites (the main note handler
 * and handleSongKnobTurn). */
let activeKnobIndex = -1;
let activeKnobTouched = false;
let activeKnobTurnUntil = 0;
const KNOB_TURN_CLAIM_MS = 1200;

function claimKnobTouch(index) {
    activeKnobIndex = index;
    activeKnobTouched = true;
}

function releaseKnobTouch(index) {
    if (activeKnobIndex !== index) return;
    activeKnobTouched = false;
}

/* The master knob has no cell on the page - the eight song knobs fill
 * it - so its value is shown as a panel OVER them while it is being
 * moved, on the same terms as a song knob's readout: for as long as it
 * is touched, and for a moment after a turn. */
let masterTouched = false;
let masterTurnUntil = 0;

function isMasterReadoutActive() {
    return masterTouched || Date.now() < masterTurnUntil;
}

function claimKnobTurn(index) {
    activeKnobIndex = index;
    activeKnobTurnUntil = Date.now() + KNOB_TURN_CLAIM_MS;
}

function isKnobReadoutActive(index) {
    return index === activeKnobIndex && (activeKnobTouched || Date.now() < activeKnobTurnUntil);
}

/* Mirrors the doubling in handleSongKnobTurn's M8-hex comment (git history):
 * M8's own parameter values are a byte (00-FF) reached by doubling the 7-bit
 * CC, so the readout must double too or it reads half of what the M8 screen
 * shows for the same knob position. */
function formatKnobReadoutValue(knob) {
    if (knob.display === KNOB_DISPLAY_HEX) {
        const shown = knob.scale === M8_NOTE_SCALE ? knob.value : knob.value * 2;
        return shown.toString(16).toUpperCase().padStart(2, "0");
    }
    /* The normalised readings work off the CC range the knob actually
     * travels (0-127), not M8's byte range, so they are the same whether
     * or not the parameter is note-scaled. */
    if (knob.display === KNOB_DISPLAY_UNIT) {
        return (knob.value / 127).toFixed(2);
    }
    if (knob.display === KNOB_DISPLAY_BIPOLAR) {
        /* Centred on 64, because that is the CC that lands on M8's own
         * centre of 0x80. The cost is that the top of the range reads
         * 0.98 rather than 1.00 - the same "a 7-bit CC cannot quite
         * reach the top" the hex reading has, where 127 shows FE. */
        return ((knob.value - 64) / 64).toFixed(2);
    }
    return String(knob.value);
}

/* A label row: the device's fixed 5x7 font plus a clear pixel above AND
 * below it. drawCell's own "locked" background uses FONT_H + 1, which
 * leaves the glyphs sitting on the bottom edge of the fill - fine for a
 * strip that spans the cell, wrong for the value pill, where the text
 * reads as resting on the border rather than inside it. */
const LABEL_ROW_H = 9;

/* Draws the active song's current page in place of the plain-text status.
 * Returns false (draws nothing) if there's no song/page yet, so the caller
 * can fall back to the text status. */
function drawSongPage() {
    const song = getActiveSong();
    const page = getActivePage();
    if (!song || !page) return false;

    ensureSongPageMeta(song, activePageIndex, page);

    const values = {};
    cachedChainParams.forEach((p, i) => {
        if (p) values[p.key] = page.knobs[i].value;
    });

    /* renderPage draws only the graphics it is HANDED - resolution and
     * drawing are separate in this library, so the caller runs the resolver.
     * Ours only ever comes back with groups this module declared on its own
     * synthetic chain_params (viz.mjs's detectors need vocabulary in the key
     * names, which these keys, being song:page:slot, do not have). */
    const pageKeys = cachedChainParams.map((p) => (p ? p.key : null));
    /* Appended PAST the eight cells the grid draws, so these lend their
     * value to a graphic without ever being rendered - see the span:false
     * note in ensureSongPageMeta. Index 0 of a one-option enum: the option
     * text is the whole payload. */
    for (const vp of cachedVizModeParams) {
        pageKeys.push(vp.key);
        values[vp.key] = 0;
    }

    const viz = resolveViz({ keys: pageKeys, metaIndex: cachedMetaIndex }).groups;

    clear_screen();

    /* The header's right-hand slot, which is otherwise unused - our pages
     * carry no name. drawHeader gives it first claim on the width and
     * fits it, so a long detail truncates rather than colliding with the
     * song name on the left. */
    const activeKnob = (activeKnobIndex >= 0 && isKnobReadoutActive(activeKnobIndex))
        ? page.knobs[activeKnobIndex] : null;
    const headerRight = (activeKnob && knobDetail(activeKnob)) || page.name || "";

    renderPage(songPageDrawCtx, {
        page: { name: headerRight, keys: pageKeys },
        metaIndex: cachedMetaIndex,
        values,
        viz,
        title: song.name || "",
        pageIndex: activePageIndex,
        pageCount: song.pages.length,
        touched: -1,
    });

    /* A graphic replaces its members' cells, so renderPage draws them no
     * labels - but you still need to know which knob is attack and which
     * is decay. The picture only uses the top 13 rows of a 26-row cell
     * (viz_draw's VIZ_ROWS), so the label row underneath is free for
     * exactly this. */
    const covered = new Set();
    for (const g of viz) {
        for (let i = 0; i < g.slotSpan; i++) covered.add(g.slotStart + i);
    }
    for (const slot of covered) {
        const knob = page.knobs[slot];
        if (!knob) continue;
        const active = isKnobReadoutActive(slot);
        drawSlotLabel(slot, active ? formatKnobReadoutValue(knob) : knob.name, active);
    }

    /* An ordinary cell already has its name from renderPage; only the
     * active one needs swapping for its value. */
    if (activeKnobIndex >= 0 && !covered.has(activeKnobIndex)
        && isKnobReadoutActive(activeKnobIndex) && page.knobs[activeKnobIndex]) {
        drawSlotLabel(activeKnobIndex,
                      formatKnobReadoutValue(page.knobs[activeKnobIndex]), true);
    }

    /* The knob-select cursor, in the same inverted pill the value
     * readout uses - one visual idea for "this slot, right now" rather
     * than a second one to learn. An empty slot has no name to invert,
     * so it gets the thing clicking it would do. */
    if (knobSelectOpen) {
        const sel = page.knobs[knobSelectIndex];
        drawSlotLabel(knobSelectIndex, sel ? sel.name : "Add", true);
    }

    /* Last, so it covers whatever it lands on. */
    if (isMasterReadoutActive()) drawMasterOverlay();

    return true;
}

/* Knob turn (CC71-78) edits the active page's knob and forwards its CC to
 * M8. Plain +/-1 per detent for now, matching the old system's step size -
 * M8-style coarse/fine (EDIT+UP/DOWN vs LEFT/RIGHT) and the rest of
 * page_controller.mjs's gesture set (hold-to-reveal, Shift precision,
 * Mute+touch reset) are deferred to a follow-up phase rather than adopted
 * blind while the device is unreachable for verification. */
/* Channels and the master knob's CC are settings now - see
 * DEFAULT_SETTINGS. M8's CONTROL MAP CHANNEL (MIDI Settings view) has to
 * match settings.knobChannel or nothing the knobs send is heard. */

function handleSongKnobTurn(data) {
    const knobIndex = data[1] - 71;
    if (knobIndex < 0 || knobIndex >= KNOBS_PER_PAGE) return;

    const page = getActivePage();
    if (!page) return;

    const delta = decodeDelta(data[2]);
    if (delta === 0) return;

    /* Shift+turn is the AUDITION: the value moves and M8 hears it, and
     * letting Shift go puts it back (noteAuditionValue below records the
     * starting point). The gesture used to be the jogwheel touch, which
     * the knob cursor now owns. */

    const knob = page.knobs[knobIndex];
    if (!knob) return; /* empty slot - this encoder controls nothing here */
    noteAuditionValue(knob);
    knob.value = Math.max(0, Math.min(127, knob.value + Math.sign(delta)));
    claimKnobTurn(knobIndex);
    /* Absolute: send the accumulated 0-127 value we track (today's
     * behaviour). Relative: forward Move's own relative encoder byte as-is
     * (1-63 CW, 65-127 CCW) and let M8 do the accumulating - `knob.value`
     * still tracks an approximate position for the on-screen display either
     * way, but isn't what's on the wire in this mode. */
    const wireValue = knob.mode === KNOB_MODE_RELATIVE ? data[2] : knob.value;
    move_midi_external_send([2 << 4 | 0xb, 0xb0 | settings.knobChannel, knob.cc, wireValue]);
    markSongsDirty();
}

/* CC79 (master) pass-through - see the comment at its call site. Not part of
 * any song's data, just forwards its own value; its only appearance on
 * screen is the transient panel drawn by drawMasterOverlay. The value
 * itself lives in `settings` so it survives a reload - see masterValue
 * in DEFAULT_SETTINGS. */
/* Where the master knob stood when a Shift audition began, or null. */
let masterAuditionValue = null;

function sendMasterValue(wire) {
    move_midi_external_send([2 << 4 | 0xb, 0xb0 | settings.masterChannel,
                             settings.masterCc, wire]);
}

function revertMasterAudition() {
    if (masterAuditionValue === null) return;
    const delta = masterAuditionValue - settings.masterValue;
    settings.masterValue = masterAuditionValue;
    masterAuditionValue = null;
    /* The autosave may already have written the mid-audition value. */
    markSongsDirty();
    if (delta === 0) return;
    if (settings.masterMode === KNOB_MODE_RELATIVE) {
        const size = Math.min(63, Math.abs(delta));
        sendMasterValue(delta > 0 ? size : 64 + size);
    } else {
        sendMasterValue(settings.masterValue);
    }
}

function handleMasterKnobTurn(data) {
    const delta = decodeDelta(data[2]);
    if (delta === 0) return;
    /* Shift auditions this knob too: the value moves and M8 hears it,
     * and letting Shift go puts it back. It is not in auditionedKnobs
     * because it is not a knob object - it has no song, name or CC of
     * its own - so it keeps its own one-slot memory. */
    if (shiftHeld && masterAuditionValue === null) masterAuditionValue = settings.masterValue;
    masterTurnUntil = Date.now() + KNOB_TURN_CLAIM_MS;
    settings.masterValue = Math.max(0, Math.min(127, settings.masterValue + Math.sign(delta)));
    markSongsDirty();
    /* Same absolute/relative split as a song knob: Absolute sends the
     * position we track, Relative forwards Move's own encoder byte and
     * lets M8 accumulate. Channel and CC are its own, not the knobs'. */
    const wireValue = settings.masterMode === KNOB_MODE_RELATIVE ? data[2] : settings.masterValue;
    sendMasterValue(wireValue);
}

/* External MIDI handler (from M8) */
globalThis.onMidiMessageExternal = function (data) {
    if (data[0] === MidiClock) return;

    let value = data[0];
    let maskedValue = (value & 0xf0);
    let noteOn = maskedValue === 0x90;
    let noteOff = maskedValue === 0x80;

    /* Handle sysex - 0xF7 can appear at different positions based on packet type:
     * CIN 0x05 (1-byte end): data[0], CIN 0x06 (2-byte end): data[1], CIN 0x07 (3-byte end): data[2]
     * Only push bytes up to and including F7 to avoid padding zeros */
    let sysexStart = value === 0xF0;
    let sysexEndPos = data[0] === 0xF7 ? 0 : data[1] === 0xF7 ? 1 : data[2] === 0xF7 ? 2 : -1;
    let sysexEnd = sysexEndPos >= 0;

    if (sysexStart) {
        sysexBuffer = [];
        sysexBuffer.push(...data);
        return;
    }
    if (sysexBuffer.length && !sysexEnd) {
        /* Safety: limit sysex buffer size to prevent unbounded growth from malformed sysex */
        if (sysexBuffer.length > 4096) {
            sysexBuffer = [];
            return;
        }
        sysexBuffer.push(...data);
        return;
    }
    if (sysexEnd) {
        /* Only push bytes up to and including F7, skip padding zeros */
        for (let i = 0; i <= sysexEndPos; i++) {
            sysexBuffer.push(data[i]);
        }
        if (arraysAreEqual(sysexBuffer, m8InitSysex)) {
            initLPP();
        } else if (sysexBuffer.length) {
            markM8Connected();
        }
        sysexBuffer = [];
        return;
    }

    if (!(noteOn || noteOff)) {
        markM8Connected();
        return;
    }

    /* If we receive LED data (note messages), M8 is connected.
     * This handles the case where M8 skips the identity request
     * because it already received our proactive identity response. */
    markM8Connected();

    lppNoteValueMap.set(data[1], [...data]);
    ledsSeenSinceConnect++;
    traceLed(data[1], data[2], noteOn, value);
    applyLppLed(data[1], data[2], maskedValue, value);
};

/* Paint one LPP LED onto the Move.
 *
 * Split out of the external handler so that REPLAYING a remembered LED -
 * which is what a view change does, through drainPadRedraw - does not have
 * to re-enter that handler. Re-entering it meant the replay ran the SysEx
 * accumulator too, and a synthetic note arriving between an F0 and its F7
 * was appended INTO the part-built message: the buffer no longer matched
 * the identity request, so the handshake went unanswered and the M8 was
 * left waiting. Rare while a redraw only followed a wheel-touch; routine
 * once a screen change could start one, because that is exactly when the
 * M8 is talking most. */
/* SHIFT HAS TO BE LET GO ON THE M8 WHEN A SCREEN TAKES OVER.
 *
 * Shift+Jog-click opens Settings, and the Shift PRESS was forwarded to
 * the M8 a moment before that happened. The screen then swallows every
 * button, the matching RELEASE among them, so the M8 is left holding a
 * key nobody is pressing: everything after that reads as Shift+whatever
 * until Shift is tapped again. The same is true of every screen that
 * owns the surface, not just Settings.
 *
 * So the M8 is told Shift is up as a screen takes over, and told it is
 * down again on the way back out if it really is still held. Driven
 * from the tick by comparing against the last frame rather than hooked
 * into each open/close, so a screen added later cannot forget it. */
function screenOwnsSurface() {
    return songMgmtOpen || settingsOpen || knobEditOpen || knobWizardOpen;
}

let surfaceOwnedLastTick = false;

function sendShiftToM8(down) {
    /* Shift is LPP 90 in every view, but ask the map rather than
     * writing the number down twice. */
    const lppNote = controlMapMoveToLpp().get(moveSHIFT);
    if (lppNote === undefined) return;
    if (down) move_midi_external_send([2 << 4 | 0x9, 0x90, lppNote, 100]);
    else move_midi_external_send([2 << 4 | 0x8, 0x80, lppNote, 0]);
}

function tickShiftHandover() {
    const owned = screenOwnsSurface();
    if (owned === surfaceOwnedLastTick) return;
    surfaceOwnedLastTick = owned;
    if (shiftHeld) sendShiftToM8(!owned);
}

function applyLppLed(lppNoteNumber, lppVelocity, maskedValue, value) {
    /* Song Management, Knob Settings and the Add Knob wizard all own the
     * pads/buttons while open (text_entry.mjs reuses the pad grid for
     * typing) - keep tracking M8's state above so a resync (queuePadRedraw,
     * on close) can catch the pads up, but don't paint over whatever screen
     * is currently showing. */
    if (screenOwnsSurface()) return;

    let activeLppToMovePadMap = padMapLppToMove();
    let moveNoteNumber = activeLppToMovePadMap.get(lppNoteNumber);
    let moveVelocity = lppColorToMoveColorMap.get(lppVelocity) ?? lppVelocity;

    if (moveNoteNumber) {
        const anim = LPP_PAD_ANIMATED[value];
        if (anim) {
            /* Both ends come from the one colour, so the pad flashes in
             * its own hue rather than alternating with whatever the
             * chain underneath happened to be.
             *
             * A REPEAT of the same request must not restart anything.
             * M8 re-sends its overlays on every grid refresh, and
             * during playback that is far more often than the flip
             * period - so resetting the phase here held the pad on one
             * colour and it never appeared to flash at all. The phase
             * is global and free-running; a pad only paints itself
             * immediately the first time, so the flash starts without
             * waiting a full period. */
            padStopPending.delete(moveNoteNumber);
            const already = animatedPads.has(moveNoteNumber);
            animatedPads.set(moveNoteNumber, [pulsePartnerOf(moveVelocity), moveVelocity]);
            if (!already) {
                move_midi_internal_send([0x09, 0x90, moveNoteNumber, moveVelocity]);
            }
            return;
        }
        /* A plain colour ends the flash - but NOT immediately. M8
         * repaints the whole grid and then re-sends its overlays, so a
         * flashing pad receives a static write on every refresh and
         * acting on it at once would cancel the flash a moment before
         * it is asked for again. Painting it would also show the chain
         * colour for a frame, which is the flicker this is all about.
         *
         * So the stop is remembered and applied on the next tick, by
         * which time the re-arm has either arrived or it has not. */
        if (animatedPads.has(moveNoteNumber)) {
            padStopPending.set(moveNoteNumber, moveVelocity);
            return;
        }
        move_midi_internal_send([(maskedValue / 16), maskedValue, moveNoteNumber, moveVelocity]);
        return;
    }

    let activeLppToMoveControlMap = controlMapLppToMove();
    let moveControlNumber = activeLppToMoveControlMap.get(lppNoteNumber);

    if (moveControlNumber === moveLOGO) {
        liveMode = moveVelocity > 0;
        updatePLAYLed();
    }

    if (moveControlNumber === movePLAY) {
        isPlaying = moveVelocity === green;
        updatePLAYLed();
        return;
    }

    if (moveControlNumber === moveLOOP || moveControlNumber === moveMUTE || moveControlNumber === moveUNDO) {
        moveVelocity = lppColorToMoveMonoMap.get(lppVelocity) ?? lppVelocity;
    }

    if (moveControlNumber) {
        move_midi_internal_send([0x0b, 0xB0, moveControlNumber, moveVelocity]);
        if (value === 0x91) {
            move_midi_internal_send([0x0b, 0xbe, moveControlNumber, black]);
        }
    }
}

/* Internal MIDI handler (from Move) */
globalThis.onMidiMessageInternal = function (data) {
    if (songMgmtOpen) {
        handleSongMgmtInput(data);
        return;
    }
    if (settingsOpen) {
        handleSettingsInput(data);
        return;
    }
    if (knobSelectOpen && handleKnobSelectInput(data)) return;
    if (knobEditOpen) {
        handleKnobEditInput(data);
        return;
    }
    if (knobWizardOpen) {
        handleKnobWizardInput(data);
        return;
    }

    const isNote = data[0] === 0x80 || data[0] === 0x90;
    const isCC = data[0] === 0xb0;
    const isAt = data[0] === 0xa0;

    if (isAt) return; /* Ignore aftertouch */

    let activeMoveToLppPadMap = padMapMoveToLpp();

    if (isNote) {
        let moveNoteNumber = data[1];

        /* Wheel touch holds the AUDITION and nothing else now - which
         * half of the grid is showing moved to the mode buttons. */
        /* The wheel holds nothing now: the audition is Shift and the
         * grid halves are the mode buttons. */
        if (moveNoteNumber === moveWHEELTouch) return;

        let lppNote = activeMoveToLppPadMap.get(moveNoteNumber);

        if (!lppNote) {
            /* The odd step notes are the song preset buttons - see
             * SONG_STEP_NOTES. They are not part of the LPP grid (only the
             * even steps, 16-30, are), so M8 never sees them. */
            const presetIndex = SONG_STEP_NOTES.indexOf(moveNoteNumber);
            if (presetIndex >= 0) {
                if (data[2] === 127) selectSongByStep(presetIndex);
                return;
            }

            /* Touching a song knob (notes 0-7; note 8 is the master
             * knob, which has no name or CC of its own) claims it for
             * the value readout until release. Shift+touch used to open
             * Knob Settings; that is the jogwheel's job now, which is
             * what freed Shift for the audition. */
            if (moveNoteNumber >= 0 && moveNoteNumber <= 7) {
                if (data[2] === 127) {
                    claimKnobTouch(moveNoteNumber);
                } else {
                    releaseKnobTouch(moveNoteNumber);
                }
            } else if (moveNoteNumber === moveMASTERTouch) {
                /* Note 8, the master knob. It has no cell to invert, so
                 * touching it raises the overlay panel instead. */
                masterTouched = data[2] === 127;
            }
            return;
        }

        let moveVelocity = data[2] * 4;
        if (moveVelocity > 127) moveVelocity = 127;

        move_midi_external_send([2 << 4 | (data[0] / 0xF), data[0], lppNote, moveVelocity]);
        return;
    }

    if (isCC) {
        let moveControlNumber = data[1];
        let activeMoveControlToLppNoteMap = controlMapMoveToLpp();
        let lppNote = activeMoveControlToLppNoteMap.get(moveControlNumber);

        /* Store current view */
        if (moveControlNumber === moveBACK || moveControlNumber === moveMENU || moveControlNumber === moveCAP) {
            currentView = moveControlNumber;
            /* Latched on the PRESS only. Shift is usually let go before
             * the button it modified, so a release would report a plain
             * Back and turn the second Session screen back into the
             * first one without the M8 having moved. */
            if (data[2] === 127) {
                /* PRESSING THE MODE YOU ARE ALREADY IN SWITCHES HALVES.
                 *
                 * Back does it for Session - and for Beat Repeat, which
                 * is a session screen and shares the button - Menu for
                 * Note, Capture for Sequencer. Pressing a DIFFERENT
                 * mode button changes mode instead and leaves the half
                 * where it was, so each screen keeps the half you last
                 * looked at.
                 *
                 * Tested BEFORE lpMode is updated, or every press would
                 * look like the mode it just set. The button is still
                 * forwarded to the M8 either way: what it means over
                 * there is the M8's business, and pressing Session
                 * while on Session is a no-op to it. */
                const target = moveControlNumber === moveBACK
                    ? (shiftHeld ? LP_SESSION_ALT : LP_SESSION)
                    : moveControlNumber === moveMENU ? LP_NOTE : LP_SEQ;
                /* A press that does not CHANGE the screen switches the
                 * half instead. Comparing the screen the press selects
                 * against the current one is what keeps Shift+Back out
                 * of it: that is a move to Beat Repeat, not a second
                 * press of the screen you are on, even though it shares
                 * the button with Session. */
                if (target === lpMode) advanceViewMode();
                else switchLpMode(target);
                /* Odd rows belongs to the primary Session screen, so a
                 * half remembered there is not necessarily legal here -
                 * and the setting may have been turned off in between. */
                reconcileOddRowsView();
                traceScreen(moveControlNumber === moveBACK
                    ? (shiftHeld ? "Session 2 (Shift+Back)" : "Session (Back)")
                    : moveControlNumber === moveMENU ? "Note (Menu)" : "Sequencer (Capture)");
            }
            updateMoveViewPulse();
        }

        /* Rec toggles session-EDIT, which is where the blinking blue
         * cursor lives. It is not a screen as far as odd rows is
         * concerned - it is still session - so it does not touch
         * lpMode, but it is very much a different screen to look at,
         * and the first trace of this missed it entirely for that
         * reason. */
        if (moveControlNumber === moveREC && data[2] === 127) {
            traceScreen("Session EDIT (Rec)");
        }

        /* Note: Shift+Wheel exit is handled at host level */

        /* Wheel click. Shift+click opens Settings, of which the song list
         * is one row (confirmed free - this combo was never forwarded to
         * M8 either way, see
         * docs/plans/2026-09-10-song-based-knob-config.md). */
        if (moveControlNumber === moveWHEEL && data[2] === 0x7f) {
            if (shiftHeld) {
                openSettings();
                return;
            }
            openKnobSelect();
            return;
        }

        /* Jog turn scrolls through the active song's pages. MoveMainKnob
         * (CC14) was completely unclaimed before this - see
         * docs/plans/2026-09-10-song-based-knob-config.md. One page per
         * detent regardless of turn speed (page counts are small, a
         * proportional jump would overshoot), clamped rather than wrapping.
         *
         * Pages are no longer added or removed by hand: they follow the
         * knobs. Adding a knob with every slot full appends a page
         * (nextFreeKnobRun), and removing the last knob from a trailing
         * page drops it again (removeKnobAt), so Shift has no separate
         * meaning here and a shifted turn just pages like an unshifted
         * one. */
        if (moveControlNumber === moveJogTurn) {
            const delta = decodeDelta(data[2]);
            if (delta !== 0) {
                const song = getActiveSong();
                if (song && song.pages.length > 1) {
                    activePageIndex = Math.max(0, Math.min(
                        song.pages.length - 1, activePageIndex + Math.sign(delta)));
                }
            }
            return;
        }

        if (!lppNote) {
            /* Knobs 1-8 (CC71-78) edit the active song page. CC79 (master) is
             * a simple song-independent pass-through - it's excluded from
             * the "8 knobs" concept everywhere (page_input.mjs's own
             * KNOB_CC_FIRST..LAST is 71-78), and the master-volume
             * suppression in init() already commits to it not being real
             * volume, so forwarding it as-is to M8 keeps the physical knob
             * doing something useful without inventing a dedicated feature
             * for it. */
            if (moveControlNumber >= 71 && moveControlNumber <= 78) {
                handleSongKnobTurn(data);
            } else if (moveControlNumber === 79) {
                handleMasterKnobTurn(data);
            }
            return;
        }

        let pressed = data[2] === 127;

        if (pressed) {
            if (moveControlNumber === moveSHIFT) {
                shiftHeld = true;
            }
            /* THE ODD VIEW SCROLLS TWO ROWS AT A TIME.
             *
             * It shows M8 rows 0, 2, 4, 6 - every other one - so a
             * one-row scroll swaps which rows are on screen and the
             * whole grid changes under your hand. Two puts the NEXT
             * four even rows up, which is what the view is for. Sent
             * as a complete extra press before the real one, so the
             * release that follows completes the second of two rather
             * than leaving a key down. */
            if (viewMode === VIEW_ODD
                && (moveControlNumber === MoveUp || moveControlNumber === MoveDown)) {
                pressOnM8(lppNote);
            }
            move_midi_external_send([2 << 4 | 0x9, 0x90, lppNote, 100]);
        } else {
            if (moveControlNumber === moveSHIFT) {
                shiftHeld = false;
                /* Letting go is what puts an auditioned knob back. */
                revertAuditionedKnobs();
            }
            move_midi_external_send([2 << 4 | 0x8, 0x80, lppNote, 0]);
        }
    }
};

globalThis.init = function () {
    console.log("M8 LPP Emulator module starting...");

    /* The master/volume knob is remapped to the "Main" slot of knob bank 8
     * (see the knob bank management section above) rather than left as real
     * volume. Without this,
     * Move processes CC 79 / master-touch note 8 in parallel - changing the
     * actual output volume and popping up Move's own volume OLED overlay -
     * while the module is showing that same knob turn as an M8 parameter.
     * No matching call on exit: the host clears this automatically on any
     * overtake-mode change, and this module has no exit path of its own
     * (Shift+Vol+Jog-Click is handled entirely at the host level). */
    if (typeof shadow_set_overtake_suppress_master_volume === 'function') {
        shadow_set_overtake_suppress_master_volume(1);
    }

    /* Armed here, but the first screen is logged from markM8Connected:
     * the settings are not read until then, and there is no screen to
     * describe until the M8 is talking. */
    /* `!= null`, not a truthiness test: the natural way to create a flag
     * file is `touch`, which leaves it EMPTY, and loadFile returns "" for
     * that - so the obvious gesture armed nothing. It read as "the
     * feature does not work" rather than as "the flag did not take",
     * which cost a diagnostic round trip. */
    traceOn = std.loadFile(tracePath("trace_on")) != null;

    /* Armed here rather than on connect - see armM8Nudge. On a reopen
     * the M8 says nothing at all, so anything waiting to be triggered
     * by the M8 waits forever. */
    armM8Nudge();
    padReassert = PAD_REASSERT_TICKS;
    songStepLedReassert = SONG_STEP_LED_REASSERT_TICKS;

    /* Proactively send LPP identity on startup - this handles the case where
     * M8 sent its identity request before the module loaded. The M8 will
     * recognize the LPP identity response and start communicating. */
    sendLPPIdentity();
};

/* Called once on teardown, regardless of which mechanism triggered it (the
 * host-level Shift+Vol+Jog-Click escape included). Forces an immediate save
 * if a knob edit is still waiting on the autosave throttle - otherwise up to
 * SONGS_AUTOSAVE_INTERVAL_MS of edits could be lost on exit. */
globalThis.onUnload = function () {
    if (songsDirty) {
        saveSongs();
        songsDirty = false;
    }
};

globalThis.tick = function () {
    traceTick();
    /* Proactively send LPP identity until M8 connects.
     * This handles the case where M8 sent its identity request before
     * the module loaded (e.g., when entering overtake mode after M8 is
     * already connected). */
    if (!m8Connected) {
        initRetryTicks++;
        if (initRetryTicks >= INIT_RETRY_INTERVAL) {
            initRetryTicks = 0;
            sendLPPIdentity();
        }
    }
    tickShiftHandover();
    tickModuleConfig();
    tickM8Nudge();
    tickPadReassert();
    tickPadAnimation();
    drainPadRedraw();
    tickSongStepLeds();
    drawUI();
    flushSongsIfDirty();
};
