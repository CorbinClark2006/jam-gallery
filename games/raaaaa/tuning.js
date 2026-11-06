// Every number the makers can tweak for the workout coach — his model, his performance, the
// workout's timing, his voice, and where he stands in the room — in one place.

// --- Camera rotation tracking (orientation.js, placement.js) ---------------------------------
// The phone's sensors give no distance and no sideways movement: this is ROTATION ONLY. The
// coach's spot in the room is remembered as a direction and re-drawn as the phone turns.
export const ORIENT_TRACKING = true; // off means the coach stays pinned to the screen instead
export const ORIENT_HFOV_DEG = 60; // ASSUMED horizontal field of view: browsers do not expose the real
// one, so a turned phone's coach will drift if the true lens is much wider or narrower than this.
export const ORIENT_SMOOTH = 0.25; // how much of each new sensor reading to adopt (0 = never move)
export const ORIENT_MAX_JUMP_DEG = 45; // a single reading that jumps more than this is a glitch: ignore it
export const ORIENT_STALE_MS = 1200; // no reading for this long means tracking is lost: fall back

// ============================================================================================
// The coach's own set of numbers. The rotation tracking above is his too — placement.js reads
// ORIENT_HFOV_DEG to keep him still as the phone turns. From here down it is the performance:
// his model, the workout's timing, his voice, and where he stands.
// ============================================================================================

// --- The coach's model (assets/coach/gymbro.glb) ------------------------------------------------
// "Cartoon muscular gym bro", CC0 (public domain) from vibeassets.io/a/vr9ojdtnca. Measured from the
// file itself: 31,251 triangles, a 24-bone skeleton, one 128 KB JPEG for the whole body, and 1.90
// metres tall with its feet on y = 0. Ten clips come inside it — Idle, Big_Wave_Hello,
// Cheer_with_Both_Hands_Up, Victory_Cheer, Confused_Scratch, Angry_Stomp, Shrug, FunnyDancing_01,
// Jazz_Hands, Grip_and_Throw_Down — and none of them is a stretch, which is why poses.js exists.
// The previous model (mannequin_man.glb, 968 triangles, PSX Animation Library) is still in the repo
// and still ships; pointing this line back at it is the one-line way back to it.
export const COACH_ASSET = 'assets/coach/gymbro.glb'; // 'assets/coach/mannequin_man.glb' for the old one
export const COACH_HEIGHT_M = 1.9; // the model's real height, so the AR scale can be trusted
export const COACH_TURN_DEG = 0; // extra yaw, if the coach should face away from the camera
// How big he stands in the room. 1 is his real 1.9 m, so at 0.4 he is about 76 cm — knee-high. The
// engine's world is in metres, so this is a real height in a real room, and the pinch gesture moves it
// between the two limits below while you are standing there looking at him.
export const COACH_SCALE = 0.4;
export const COACH_SCALE_MIN = 0.12; // smallest pinch: about 23 cm, a figurine on the floor
export const COACH_SCALE_MAX = 1.5; // biggest pinch: taller than you, if you want that
export const COACH_FADE = 0.35; // seconds to cross-fade between two clips: no snapping, no T-pose
// How fast the coach raises his arms into a stretch and lowers them again, per second. Higher is a
// snappier reach, lower is a slower one. At 1.1 he takes about a second and a half to get there.
export const COACH_STRETCH_RAMP = 1.1;

// --- The workout's own clock (workout.js) ------------------------------------------------------
// Each step either holds for a fixed count, or waits for the current line to finish being spoken.
export const WORKOUT_OVERHEAD_HOLD = 10; // seconds holding the overhead stretch, counted down on screen
export const WORKOUT_SIDE_HOLD = 10; // seconds on the side stretch: about 5 each way
export const WORKOUT_SIDE_SWAP = 5; // seconds before the side stretch changes side
export const WORKOUT_STEP_MAX = 14; // hard cap on any one step: no step can ever deadlock the workout
export const WORKOUT_GAP = 0.4; // beat between one step ending and the next starting

// --- The voice (speech.js) ---------------------------------------------------------------------
// The browser speaks the lines itself: no key, no server, nothing leaves the phone.
export const SPEECH_RATE = 1; // 0.1 to 10. Below 1 is slower and friendlier
export const SPEECH_PITCH = 1; // 0 to 2
export const SPEECH_LANG = 'en'; // prefers an English voice; falls back to the browser's default
export const SPEECH_MAX_MS = 15000; // a line that never reports finishing is cut off here, never hangs
export const SPEECH_MIN_MS = 700; // captions show for at least this long, so a one-word line still reads

// --- Placing the coach in the room (placement.js) ----------------------------------------------
// How the coach is framed on screen. These four are the numbers to fiddle with if he looks too
// small, too big, or too high. The distance is not set directly: it is worked out from the two
// numbers below so that he always fills the same share of the screen, whatever shape the phone is.
export const PLACE_REACH_M = 2.05; // how tall he is with both arms stretched overhead, in metres.
//                                   Measured on this model's own overhead pose: his hands reach
//                                   1.95 m, and 2.05 leaves a hand's width of air above them.
export const PLACE_FILL = 0.76; // how much of the screen's height that should take up. 0.76 leaves
//                                a strip of air above his hands and a patch of floor under his feet.
export const PLACE_MIN_M = 2.5; // never stand him nearer than this, however tall the screen is
export const PLACE_MAX_M = 11; // nor further than this, however wide it is
