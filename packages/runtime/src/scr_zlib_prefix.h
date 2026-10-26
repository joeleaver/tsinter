/* GENERATED from packages/runtime/vendor/zlib-chromium/chromeconf.h (every
 * `#define X Cr_z_X` respelled `#define X scr_z_X`) plus the cpu_features
 * globals chromeconf.h leaves unprefixed — do not edit by hand; the drift
 * check is packages/runtime/test/zlib-prefix.test.ts.
 *
 * The vendored zlib's symbol prefix. Chromium renames every zlib symbol
 * Cr_z_* (chromeconf.h); Node's copy of zconf.h comments that include out.
 * We use our OWN prefix instead of Chromium's: a host that embeds a
 * tsinter library archive (the engine-plugin target) may itself link
 * Chromium's zlib (CEF and the like), and with the same Cr_z_ names the
 * two would collide or resolve to the wrong revision. cc.ts force-includes
 * this header into every vendored zlib TU (zlibDefines); scr_zlib.c and
 * scr_fetch.c include it before zlib.h. Symbol names only — no code
 * changes. `gzgetc` is left out: zlib.h redefines it as a function-like
 * macro, and nothing here uses the gzFile API. */
#ifndef SCR_ZLIB_PREFIX_H
#define SCR_ZLIB_PREFIX_H
#define SCR_ZLIB_PREFIX_SET

#define _dist_code scr_z__dist_code
#define _length_code scr_z__length_code
#define _tr_align scr_z__tr_align
#define _tr_flush_bits scr_z__tr_flush_bits
#define _tr_flush_block scr_z__tr_flush_block
#define _tr_init scr_z__tr_init
#define _tr_stored_block scr_z__tr_stored_block
#define _tr_tally scr_z__tr_tally
#define adler32 scr_z_adler32
#define adler32_combine scr_z_adler32_combine
#define adler32_combine64 scr_z_adler32_combine64
#define adler32_z scr_z_adler32_z
#define compress scr_z_compress
#define compress2 scr_z_compress2
#define compressBound scr_z_compressBound
#define crc32 scr_z_crc32
#define crc32_combine scr_z_crc32_combine
#define crc32_combine64 scr_z_crc32_combine64
#define crc32_combine_gen64 scr_z_crc32_combine_gen64
#define crc32_combine_gen scr_z_crc32_combine_gen
#define crc32_combine_op scr_z_crc32_combine_op
#define crc32_z scr_z_crc32_z
#define deflate scr_z_deflate
#define deflateBound scr_z_deflateBound
#define deflateCopy scr_z_deflateCopy
#define deflateEnd scr_z_deflateEnd
#define deflateGetDictionary scr_z_deflateGetDictionary
#define deflateInit2_ scr_z_deflateInit2_
#define deflateInit_ scr_z_deflateInit_
#define deflateParams scr_z_deflateParams
#define deflatePending scr_z_deflatePending
#define deflatePrime scr_z_deflatePrime
#define deflateReset scr_z_deflateReset
#define deflateResetKeep scr_z_deflateResetKeep
#define deflateSetDictionary scr_z_deflateSetDictionary
#define deflateSetHeader scr_z_deflateSetHeader
#define deflateTune scr_z_deflateTune
#define deflate_copyright scr_z_deflate_copyright
#define get_crc_table scr_z_get_crc_table
#define gz_error scr_z_gz_error
#define gz_intmax scr_z_gz_intmax
#define gz_strwinerror scr_z_gz_strwinerror
#define gzbuffer scr_z_gzbuffer
#define gzclearerr scr_z_gzclearerr
#define gzclose scr_z_gzclose
#define gzclose_r scr_z_gzclose_r
#define gzclose_w scr_z_gzclose_w
#define gzdirect scr_z_gzdirect
#define gzdopen scr_z_gzdopen
#define gzeof scr_z_gzeof
#define gzerror scr_z_gzerror
#define gzflush scr_z_gzflush
#define gzfread scr_z_gzfread
#define gzfwrite scr_z_gzfwrite
#define gzgetc_ scr_z_gzgetc_
#define gzgets scr_z_gzgets
#define gzoffset scr_z_gzoffset
#define gzoffset64 scr_z_gzoffset64
#define gzopen scr_z_gzopen
#define gzopen64 scr_z_gzopen64
#define gzopen_w scr_z_gzopen_w
#define gzprintf scr_z_gzprintf
#define gzputc scr_z_gzputc
#define gzputs scr_z_gzputs
#define gzread scr_z_gzread
#define gzrewind scr_z_gzrewind
#define gzseek scr_z_gzseek
#define gzseek64 scr_z_gzseek64
#define gzsetparams scr_z_gzsetparams
#define gztell scr_z_gztell
#define gztell64 scr_z_gztell64
#define gzungetc scr_z_gzungetc
#define gzvprintf scr_z_gzvprintf
#define gzwrite scr_z_gzwrite
#define inflate scr_z_inflate
#define inflateBack scr_z_inflateBack
#define inflateBackEnd scr_z_inflateBackEnd
#define inflateBackInit_ scr_z_inflateBackInit_
#define inflateCodesUsed scr_z_inflateCodesUsed
#define inflateCopy scr_z_inflateCopy
#define inflateEnd scr_z_inflateEnd
#define inflateGetDictionary scr_z_inflateGetDictionary
#define inflateGetHeader scr_z_inflateGetHeader
#define inflateInit2_ scr_z_inflateInit2_
#define inflateInit_ scr_z_inflateInit_
#define inflateMark scr_z_inflateMark
#define inflatePrime scr_z_inflatePrime
#define inflateReset scr_z_inflateReset
#define inflateReset2 scr_z_inflateReset2
#define inflateResetKeep scr_z_inflateResetKeep
#define inflateSetDictionary scr_z_inflateSetDictionary
#define inflateSync scr_z_inflateSync
#define inflateSyncPoint scr_z_inflateSyncPoint
#define inflateUndermine scr_z_inflateUndermine
#define inflateValidate scr_z_inflateValidate
#define inflate_copyright scr_z_inflate_copyright
#define inflate_fast scr_z_inflate_fast
#define inflate_table scr_z_inflate_table
#define uncompress scr_z_uncompress
#define uncompress2 scr_z_uncompress2
#define zError scr_z_zError
#define zcalloc scr_z_zcalloc
#define zcfree scr_z_zcfree
#define zlibCompileFlags scr_z_zlibCompileFlags
#define zlibVersion scr_z_zlibVersion
#define Bytef scr_z_Bytef
#define alloc_func scr_z_alloc_func
#define charf scr_z_charf
#define free_func scr_z_free_func
#define gzFile scr_z_gzFile
#define gz_header scr_z_gz_header
#define gz_headerp scr_z_gz_headerp
#define in_func scr_z_in_func
#define intf scr_z_intf
#define out_func scr_z_out_func
#define uInt scr_z_uInt
#define uIntf scr_z_uIntf
#define uLong scr_z_uLong
#define uLongf scr_z_uLongf
#define voidp scr_z_voidp
#define voidpc scr_z_voidpc
#define voidpf scr_z_voidpf
#define gz_header_s scr_z_gz_header_s
#define z_errmsg scr_z_z_errmsg
#define copy_with_crc scr_z_copy_with_crc
#define crc_finalize scr_z_crc_finalize
#define crc_fold_512to32 scr_z_crc_fold_512to32
#define crc_fold_copy scr_z_crc_fold_copy
#define crc_fold_init scr_z_crc_fold_init
#define crc_reset scr_z_crc_reset
#define fill_window_sse scr_z_fill_window_sse
#define deflate_read_buf scr_z_deflate_read_buf
#define x86_check_features scr_z_x86_check_features
#define x86_cpu_enable_simd scr_z_x86_cpu_enable_simd
#define adler32_simd_ scr_z_adler32_simd_
#define x86_cpu_enable_ssse3 scr_z_x86_cpu_enable_ssse3
#define inflate_fast_chunk_ scr_z_inflate_fast_chunk_
#define crc32_sse42_simd_ scr_z_crc32_sse42_simd_
#define arm_cpu_enable_crc32 scr_z_arm_cpu_enable_crc32
#define arm_cpu_enable_pmull scr_z_arm_cpu_enable_pmull
#define arm_check_features scr_z_arm_check_features
#define armv8_crc32_little scr_z_armv8_crc32_little
#define armv8_crc32_pmull_little scr_z_armv8_crc32_pmull_little
#define cpu_check_features scr_z_cpu_check_features
#define x86_cpu_enable_sse2 scr_z_x86_cpu_enable_sse2

/* cpu_features.c globals chromeconf.h does not rename */
#define riscv_cpu_enable_rvv scr_z_riscv_cpu_enable_rvv
#define riscv_cpu_enable_vclmul scr_z_riscv_cpu_enable_vclmul
#define x86_cpu_enable_avx512 scr_z_x86_cpu_enable_avx512

#endif /* SCR_ZLIB_PREFIX_H */
