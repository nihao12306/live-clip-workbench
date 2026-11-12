#!/usr/bin/env bash
set -euo pipefail

workspace="$(pwd)"
build_dir="$(mktemp -d)"
prefix="$build_dir/install"
if [ "${MSYSTEM:-}" = UCRT64 ]; then
  platform=win32
  architecture=x64
  extension=.exe
  prefix="$(cygpath -m "$prefix")"
  jobs="$(nproc)"
  ass_flags=(--enable-directwrite)
  ffmpeg_flags=(--target-os=mingw32 --extra-cflags="-I$prefix/include" --extra-ldflags="-static -L$prefix/lib" --extra-libs=-lstdc++)
else
  platform=darwin
  architecture="$(uname -m)"
  if [ "$architecture" = x86_64 ]; then architecture=x64; fi
  extension=
  jobs="$(sysctl -n hw.ncpu)"
  export MACOSX_DEPLOYMENT_TARGET=12.0
  ass_flags=(--enable-coretext)
  ffmpeg_flags=(--extra-libs=-lc++)
fi
sources="$build_dir/sources"
mkdir -p "$prefix" "$sources" "$workspace/media-tools"

# Keep ambient libraries out of the resulting portable executables.
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=""

fetch() {
  local name="$1" url="$2"
  curl -fsSL --retry 3 --max-time 120 "$url" -o "$sources/$name.tar.gz"
  mkdir -p "$build_dir/$name"
  tar -xf "$sources/$name.tar.gz" -C "$build_dir/$name" --strip-components=1
}

fetch x264 https://github.com/mirror/x264/archive/c24e06c2e184345ceb33eb20a15d1024d9fd3497.tar.gz
fetch freetype https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.gz
fetch fribidi https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz
fetch harfbuzz https://github.com/harfbuzz/harfbuzz/releases/download/8.5.0/harfbuzz-8.5.0.tar.xz
fetch libass https://github.com/libass/libass/releases/download/0.17.4/libass-0.17.4.tar.xz
fetch ffmpeg https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz
if [ "$platform" = win32 ]; then
  fetch zlib https://zlib.net/fossils/zlib-1.3.1.tar.gz
  (
    cd "$build_dir/zlib"
    make -f win32/Makefile.gcc -j"$jobs" libz.a
    mkdir -p "$prefix/include" "$prefix/lib"
    cp zlib.h zconf.h "$prefix/include/"
    cp libz.a "$prefix/lib/"
  )
fi

(
  cd "$build_dir/x264"
  ./configure --prefix="$prefix" --enable-static --disable-cli --enable-pic
  make -j"$jobs" install
)
(
  cd "$build_dir/freetype"
  ./configure --prefix="$prefix" --disable-shared --without-zlib --without-bzip2 --without-png --without-harfbuzz --without-brotli
  make -j"$jobs" install
)
(
  cd "$build_dir/fribidi"
  ./configure --prefix="$prefix" --disable-shared --disable-docs
  make -j"$jobs" install
)
meson setup "$build_dir/harfbuzz-build" "$build_dir/harfbuzz" \
  --prefix="$prefix" --libdir=lib --buildtype=release --default-library=static \
  -Dauto_features=disabled -Dfreetype=enabled -Dtests=disabled -Ddocs=disabled
meson compile -C "$build_dir/harfbuzz-build" -j "$jobs"
meson install -C "$build_dir/harfbuzz-build"
(
  cd "$build_dir/libass"
  ./configure --prefix="$prefix" --disable-shared --disable-fontconfig "${ass_flags[@]}"
  make -j"$jobs" install
)
(
  cd "$build_dir/ffmpeg"
  ./configure --prefix="$prefix" --disable-autodetect --disable-doc --disable-ffplay \
    --enable-gpl --enable-libx264 --enable-libass --enable-libfreetype \
    --enable-libharfbuzz --enable-libfribidi --enable-zlib \
    --pkg-config-flags=--static "${ffmpeg_flags[@]}"
  make -j"$jobs" "ffmpeg$extension" "ffprobe$extension"
)
install -m 755 "$build_dir/ffmpeg/ffmpeg$extension" "$workspace/node_modules/ffmpeg-static/ffmpeg$extension"
rm -rf "$workspace/node_modules/ffprobe-static/bin"
ffprobe_dir="$workspace/node_modules/ffprobe-static/bin/$platform/$architecture"
mkdir -p "$ffprobe_dir"
install -m 755 "$build_dir/ffmpeg/ffprobe$extension" "$ffprobe_dir/ffprobe$extension"

cp "$workspace/.github/scripts/build-media-tools.sh" "$sources/"
cp "$workspace/LICENSE" "$workspace/media-tools/WORKBENCH-LICENSE.txt"
cp "$build_dir/ffmpeg/COPYING.GPLv2" "$workspace/media-tools/FFMPEG-GPL-2.0.txt"
cat > "$workspace/media-tools/FFMPEG-NOTICE.txt" <<'EOF'
This package includes separate FFmpeg and FFprobe 7.1.1 executables built
with GPL components. See FFMPEG-GPL-2.0.txt for the GNU GPL version 2.
FFmpeg and the linked dependencies retain their own copyright and licenses.
Corresponding source archives, license texts, and the build recipe are in
ffmpeg-corresponding-source.tar.gz in this directory.
The Live Clip Workbench application is separately licensed under MIT.
EOF
tar -czf "$workspace/media-tools/ffmpeg-corresponding-source.tar.gz" -C "$sources" .
