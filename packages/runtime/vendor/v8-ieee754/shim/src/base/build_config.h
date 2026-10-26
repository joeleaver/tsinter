// tsinter shim for V8's src/base/build_config.h: ieee754.cc reads only
// V8_CC_MSVC from it (to silence an MSVC warning). Not a V8 file; see
// ../../../README.md.
#ifndef V8_BASE_BUILD_CONFIG_H_
#define V8_BASE_BUILD_CONFIG_H_

#define V8_CC_MSVC 0

#endif  // V8_BASE_BUILD_CONFIG_H_
