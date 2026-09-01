/* INC-24 P1: the pattern AST. libregexp.c's re_parse_term (1855-2379)
 * fuses parsing and bytecode emission into one pass with retroactive
 * byte-splicing (dbuf_insert, backpatched jump offsets) — design §2.1's
 * own pipeline lists parse and assemble as SEPARATE sequential stages
 * ("parse -> validate -> assemble libregexp-compatible bytecode"), which
 * only makes sense with an intermediate representation between them, and
 * matches design §6.1's two SEPARATE oracle instruments (parser-verdict
 * vs assembler-bytes, independently testable). This file is that
 * intermediate representation — a deliberate architectural departure
 * from the reference's fused C implementation, not a transcription
 * shortcut: the "1:1 transcription" mandate binds the SEMANTIC decisions
 * (every opcode choice, quantifier-compilation strategy, backpatch
 * offset must reproduce byte-identical bytecode), not the reference's
 * C-specific implementation technique for reaching that bytecode.
 *
 * Flag-dependent decisions (line_start vs line_start_m, ignore_case
 * canonicalization, word_boundary vs word_boundary_i) are baked into
 * nodes AT PARSE TIME, matching how the reference itself decides them
 * inline during its single pass (re_parse_term reads `s->multi_line`
 * etc. at the moment it emits each opcode) — the assembler (not yet
 * built) does not need to re-derive flag-nesting state by walking
 * modifier-group scopes; a modifier group is TRANSPARENT in this AST
 * (see regex-parser.ts) precisely because the reference itself emits no
 * opcode for entering/leaving one — only nested atoms' own encoding
 * changes. */
import type { CharRange } from "./regex-charclass.js";

/** `ignoreCase` on "char"/"charClass": re_emit_char and re_emit_range
 * BOTH pick REOP_char_i/REOP_range_i (etc.) from the CURRENT `s-
 * >ignore_case` at the exact moment they emit (libregexp.c:1278-1284,
 * :1235-1269) — even though the PATTERN-side value/range is already
 * Canonicalize()'d (or, for a class, will be case-closed — see
 * regex-class-closure.ts). This is NOT redundant: the interpreter's _i
 * opcodes canonicalize the SUBJECT character at match time before
 * comparing, which is the OTHER half of "Canonicalize(pattern) ==
 * Canonicalize(subject)" — the pattern side is folded in at compile
 * time (once), the subject side can't be (it varies per match). Since
 * ignore_case can differ PER ATOM (a modifier group changes it only for
 * its body), this must be recorded on each node, not assumed constant
 * across the whole pattern — a real gap this file's build caught before
 * the assembler was designed around a wrong shape. */
export type RegexAst =
  | { kind: "lineStart"; multiline: boolean }
  | { kind: "lineEnd"; multiline: boolean }
  | { kind: "dot"; dotAll: boolean }
  | { kind: "char"; cp: number; ignoreCase: boolean } // cp already Canonicalize()'d if ignoreCase
  | { kind: "charClass"; cr: CharRange; ignoreCase: boolean; bareShorthand: "s" | "S" | null } // cr already case-closed if ignoreCase, EXCEPT for a \d\D\s\S\w\W member (used raw — see regex-charclass.ts's ClassAtomResult.dsw doc for the full, empirically-confirmed rule). bareShorthand: non-null ONLY for a bare (non-bracketed) \s/\S atom — libregexp.c:2186-2190's REOP_space/REOP_not_space fast path, which the assembler picks over the general range encoding regardless of ignoreCase (the reference checks this BEFORE ever consulting s->ignore_case for a class-range atom)
  | { kind: "wordBoundary"; negate: boolean; ignoreCaseUnicode: boolean }
  | { kind: "backreference"; indices: readonly number[]; ignoreCase: boolean } // one entry for \N; possibly several for \k<name>
  | { kind: "group"; capture: number | null; name: string | null; nameScope: number; body: RegexAst } // capture: null = non-capturing, else 0-based capture index. name/nameScope: the named-groups trailer's per-entry payload (libregexp.c:2005-2018) — name is null for an unnamed capture (irrelevant nameScope, always 0); ignored entirely when capture is null (non-capturing groups get no group_names entry at all)
  | { kind: "lookahead"; negate: boolean; backward: boolean; body: RegexAst }
  | { kind: "quantifier"; min: number; max: number; greedy: boolean; body: RegexAst }
  | { kind: "alternative"; terms: readonly RegexAst[] }
  | { kind: "disjunction"; alternatives: readonly RegexAst[] };
