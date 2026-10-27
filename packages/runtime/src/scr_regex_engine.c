/* The native regex engine's own translation unit: the generated
 * scr_regex_engine.h (the wasm tier's regex engine translated to C; see its
 * header) compiled with its entry points external. It depends on nothing
 * else in the runtime, so cc.ts compiles it ONCE per flavor and target and
 * caches the object (ensureRegexEngineObject) instead of recompiling ~10k
 * lines of generated C for every regex-using build. scr_regex.c includes
 * the same header for its declarations only and provides scr_rx_trap /
 * scr_rx_oom. */
#define SCR_RX_API
#include "scr_regex_engine.h"
