/* INC-24 P1, CP3: libregexp's REOP_* opcode enum and header layout
 * (libregexp-opcode.h, libregexp.c:123-128), transcribed 1:1 — these are
 * DATA, not algorithm, so there is no "equivalent" version to prefer;
 * the enum ORDER is load-bearing (opcode values are the byte encoding
 * itself) and several opcodes are DELIBERATELY placed "must come after"
 * a sibling per the header's own comments (e.g. not_space right after
 * space, char32_i right after char32) — REPRODUCED IN THE SAME ORDER,
 * not just the same set, since some interpreter logic (not yet built)
 * may rely on adjacency (e.g. `opcode - REOP_space` toggling). */
export const REOP = {
  invalid: 0, // never used
  char: 1,
  char_i: 2,
  char32: 3,
  char32_i: 4,
  dot: 5,
  any: 6, // same as dot but match any character including line terminator
  space: 7,
  not_space: 8, // must come after
  line_start: 9,
  line_start_m: 10,
  line_end: 11,
  line_end_m: 12,
  goto: 13,
  split_goto_first: 14,
  split_next_first: 15,
  match: 16,
  lookahead_match: 17,
  negative_lookahead_match: 18, // must come after
  save_start: 19, // save start position
  save_end: 20, // save end position, must come after saved_start
  save_reset: 21, // reset save positions
  loop: 22, // decrement the top the stack and goto if != 0
  loop_split_goto_first: 23, // loop and then split
  loop_split_next_first: 24,
  loop_check_adv_split_goto_first: 25, // loop and then check advance and split
  loop_check_adv_split_next_first: 26,
  set_i32: 27, // store the immediate value to a register
  word_boundary: 28,
  word_boundary_i: 29,
  not_word_boundary: 30,
  not_word_boundary_i: 31,
  back_reference: 32, // variable length
  back_reference_i: 33, // must come after
  backward_back_reference: 34, // must come after
  backward_back_reference_i: 35, // must come after
  range: 36, // variable length
  range_i: 37, // variable length
  range32: 38, // variable length
  range32_i: 39, // variable length
  lookahead: 40,
  negative_lookahead: 41, // must come after
  set_char_pos: 42, // store the character position to a register
  check_advance: 43, // check that the register is different from the character position
  prev: 44, // go to the previous char
} as const;

/** reopcode_info's `size` column (libregexp.c:113-121) — the FIXED
 * portion of each opcode's encoding (1 for the opcode byte alone, more
 * for immediates); `range`/`range_i`/`range32`/`range32_i` and
 * `back_reference`/its variants are "variable length" (a count/length
 * field followed by that many entries) — their fixed size here covers
 * only the opcode byte + the length-prefix field itself, matching
 * DEF(range, 3)'s own comment (the variable part is counted separately
 * by whatever walks the bytecode). Indexed by REOP value. */
export const REOP_SIZE: readonly number[] = [
  1, // invalid
  3, // char
  3, // char_i
  5, // char32
  5, // char32_i
  1, // dot
  1, // any
  1, // space
  1, // not_space
  1, // line_start
  1, // line_start_m
  1, // line_end
  1, // line_end_m
  5, // goto
  5, // split_goto_first
  5, // split_next_first
  1, // match
  1, // lookahead_match
  1, // negative_lookahead_match
  2, // save_start
  2, // save_end
  3, // save_reset
  6, // loop
  10, // loop_split_goto_first
  10, // loop_split_next_first
  10, // loop_check_adv_split_goto_first
  10, // loop_check_adv_split_next_first
  6, // set_i32
  1, // word_boundary
  1, // word_boundary_i
  1, // not_word_boundary
  1, // not_word_boundary_i
  2, // back_reference (variable length)
  2, // back_reference_i (must come after)
  2, // backward_back_reference (must come after)
  2, // backward_back_reference_i (must come after)
  3, // range (variable length)
  3, // range_i (variable length)
  3, // range32 (variable length)
  3, // range32_i (variable length)
  5, // lookahead
  5, // negative_lookahead
  2, // set_char_pos
  2, // check_advance
  1, // prev
];

/** RE_HEADER_* (libregexp.c:123-128) — the 8-byte bytecode header layout:
 * u16 flags, u8 capture_count, u8 register_count, u32 bytecode_length. */
export const RE_HEADER_FLAGS = 0;
export const RE_HEADER_CAPTURE_COUNT = 2;
export const RE_HEADER_REGISTER_COUNT = 3;
export const RE_HEADER_BYTECODE_LEN = 4;
export const RE_HEADER_LEN = 8;

/** LRE_FLAG_* (libregexp.h) — the flags word's bit assignments. Only the
 * ones this port's header-writing path needs are listed; more are added
 * as the assembler grows into needing them. */
export const LRE_FLAG_GLOBAL = 1 << 0;
export const LRE_FLAG_IGNORECASE = 1 << 1;
export const LRE_FLAG_MULTILINE = 1 << 2;
export const LRE_FLAG_DOTALL = 1 << 3;
export const LRE_FLAG_UNICODE = 1 << 4;
export const LRE_FLAG_STICKY = 1 << 5;
export const LRE_FLAG_INDICES = 1 << 6; // 'd' — refused at the frontend (SC1120), never set here
export const LRE_FLAG_NAMED_GROUPS = 1 << 7;
export const LRE_FLAG_UNICODE_SETS = 1 << 8; // 'v' — refused at the frontend (SC1120), never set here

export const CAPTURE_COUNT_MAX = 255; // libregexp.c:71
export const REGISTER_COUNT_MAX = 255; // libregexp.c:72
