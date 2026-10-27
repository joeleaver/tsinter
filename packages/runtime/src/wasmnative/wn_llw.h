/* undici's HTTP/1 parser, as the native runner's fetch links it: the llhttp
 * wasm module Node's fetch instantiates (backend/wasm/undici-llhttp.ts),
 * translated to C by wasm2c (backend/wasm-native.ts, ensureLlhttpObject).
 * The unit includes this header, so a declaration here that does not match
 * the module's own signature is a compile error, never a silent mismatch.
 * Pointers are offsets into the module's memory (wn_llw_export_memory(),
 * whose base never moves). wn_fetch.c defines the callbacks — undici's
 * wasm_on_* imports, its Parser's methods. */
#ifndef WN_LLW_H
#define WN_LLW_H
#include <stdint.h>

void wn_llw_init(void);
void wn_llw_initialize(void);
uint8_t *wn_llw_export_memory(void);
int32_t wn_llw_llhttp_alloc(int32_t type);
void wn_llw_llhttp_free(int32_t parser);
int32_t wn_llw_llhttp_execute(int32_t parser, int32_t data, int32_t len);
int32_t wn_llw_llhttp_finish(int32_t parser);
int32_t wn_llw_llhttp_get_error_reason(int32_t parser);
int32_t wn_llw_llhttp_get_error_pos(int32_t parser);
int32_t wn_llw_malloc(int32_t n);
void wn_llw_free(int32_t p);

int32_t wn_llw_on_headers_complete(int32_t parser, int32_t status, int32_t upgrade, int32_t keep_alive);
int32_t wn_llw_on_message_begin(int32_t parser);
int32_t wn_llw_on_url(int32_t parser, int32_t at, int32_t len);
int32_t wn_llw_on_status(int32_t parser, int32_t at, int32_t len);
int32_t wn_llw_on_header_field(int32_t parser, int32_t at, int32_t len);
int32_t wn_llw_on_header_value(int32_t parser, int32_t at, int32_t len);
int32_t wn_llw_on_body(int32_t parser, int32_t at, int32_t len);
int32_t wn_llw_on_message_complete(int32_t parser);

#endif
