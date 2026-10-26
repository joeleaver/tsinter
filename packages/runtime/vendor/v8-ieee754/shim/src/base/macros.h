// tsinter shim for V8's src/base/macros.h: ONLY what src/base/ieee754.cc
// uses from it -- base::bit_cast and the two attribute macros (which V8
// defines in src/base/compiler-specific.h; neither changes a value). Not a
// V8 file; see ../../../README.md.
#ifndef V8_BASE_MACROS_H_
#define V8_BASE_MACROS_H_

#include <stdint.h>
#include <string.h>

#define V8_INLINE inline __attribute__((always_inline))
#define V8_WARN_UNUSED_RESULT __attribute__((warn_unused_result))

namespace v8 {
namespace base {

// V8's bit_cast is std::bit_cast (C++20) / __builtin_bit_cast; this is the
// same bits through memcpy, which every C++17 compiler folds to a move.
template <class Dest, class Source>
V8_INLINE Dest bit_cast(Source const& source) {
  static_assert(sizeof(Dest) == sizeof(Source), "bit_cast sizes must match");
  Dest dest;
  memcpy(&dest, &source, sizeof(dest));
  return dest;
}

}  // namespace base
}  // namespace v8

#endif  // V8_BASE_MACROS_H_
