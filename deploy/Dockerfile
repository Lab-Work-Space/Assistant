# Built by lw-git with the LEGACY builder (DOCKER_BUILDKIT=0): no heredocs, no BuildKit-only flags on RUN/COPY, and no automatic TARGETARCH
# (every RUN below derives the architecture from ${TARGETARCH:-} with a `uname -m` fallback). A unit test enforces this.
# Base pinned by digest (Gate 1 D24). Refresh: docker buildx imagetools inspect node:22-alpine
ARG NODE_IMAGE=node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts (T37, P22): msedge-tts 2.1.1 ships a `preinstall: npx only-allow pnpm`, which would fetch an unpinned package at
# build time. No dependency needs its scripts (@google/genai's is a no-op echo, protobufjs' only warns; davey/opusscript have none).
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# P22 media binaries: pinned by version AND sha256, per architecture, never auto-updated (yt-dlp is never run with -U).
# The yt-dlp values are PINNED_BINARIES in voice/binaries.ts (a unit test keeps them equal; the boot check re-hashes them).
# Bump procedure: docs/operations/media-binaries.md#media-binaries-p22.
# yt-dlp: the official onedir build. The one-file build self-extracts ~96 MB of .so files into TMPDIR, which the container's
# 16 MB noexec /tmp refuses. The release's SHA2-256SUMS must carry a valid signature from the yt-dlp signing key (pinned by
# fingerprint; the key is committed as voice/yt-dlp-signing-key.asc), the zip must match both that file and the pin below,
# and the extracted tree must match the pinned tree hash.
FROM ${NODE_IMAGE} AS ytdlp
ARG TARGETARCH
ARG YTDLP_VERSION=2026.10.26
ARG YTDLP_SIGNER_FPR=AC0CBBE6848D6A873464AF4E57CF65933B5A7581
ARG YTDLP_ZIP_SHA256_AMD64=c3a67f7c14d4cbf876e7801039237fc16b929a629c72f9c785ec3fdc8aa40748
ARG YTDLP_ZIP_SHA256_ARM64=1648beeb7b0c78b471654262697066c016783d33813659367a5c274828ba3240
ARG YTDLP_TREE_SHA256_AMD64=726fe7666e5d027161232d70bd1dab3dbde13554093c290c0113036adc7fb3e4
ARG YTDLP_TREE_SHA256_ARM64=1c033be9483fcfb1352fc67d37aaeab48ee6ee0382f9db58f654203d4247bc12
COPY voice/yt-dlp-signing-key.asc /tmp/yt-dlp-signing-key.asc
RUN set -eu; \
    arch="${TARGETARCH:-}"; \
    if [ -z "$arch" ]; then case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) echo "unsupported machine $(uname -m)" >&2; exit 1 ;; esac; fi; \
    case "$arch" in \
      amd64) asset=yt-dlp_musllinux; zip_sha="$YTDLP_ZIP_SHA256_AMD64"; tree_sha="$YTDLP_TREE_SHA256_AMD64" ;; \
      arm64) asset=yt-dlp_musllinux_aarch64; zip_sha="$YTDLP_ZIP_SHA256_ARM64"; tree_sha="$YTDLP_TREE_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH '$arch'" >&2; exit 1 ;; \
    esac; \
    apk add --no-cache curl gnupg unzip >/dev/null; \
    export GNUPGHOME="$(mktemp -d)"; \
    gpg --batch --quiet --import /tmp/yt-dlp-signing-key.asc; \
    gpg --batch --with-colons --fingerprint | grep -q "^fpr:::::::::${YTDLP_SIGNER_FPR}:"; \
    cd /tmp; base="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}"; \
    curl -fsSLo SHA2-256SUMS "$base/SHA2-256SUMS"; curl -fsSLo SHA2-256SUMS.sig "$base/SHA2-256SUMS.sig"; curl -fsSLo "$asset.zip" "$base/$asset.zip"; \
    gpg --batch --status-fd 1 --verify SHA2-256SUMS.sig SHA2-256SUMS 2>/dev/null | grep -q "^\[GNUPG:\] VALIDSIG .* ${YTDLP_SIGNER_FPR}$"; \
    grep -qx "${zip_sha}  ${asset}.zip" SHA2-256SUMS; \
    echo "${zip_sha}  ${asset}.zip" | sha256sum -c -; \
    mkdir -p /opt/yt-dlp; unzip -q "$asset.zip" -d /opt/yt-dlp; mv "/opt/yt-dlp/$asset" /opt/yt-dlp/yt-dlp; \
    got="$(cd /opt/yt-dlp && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"; \
    [ "$got" = "$tree_sha" ] || { echo "yt-dlp tree sha256 $got != $tree_sha" >&2; exit 1; }; \
    chmod -R u=rwX,go=rX /opt/yt-dlp; chmod 0755 /opt/yt-dlp/yt-dlp

# ffmpeg (G2-01): built from the ffmpeg.org release tarball, not an apk or a vendor binary (Alpine's 8.1.3 carries unpatched HIGH CVEs;
# the BtbN "static" builds are glibc-dynamic and do not run on musl). The tarball must carry a valid detached signature from the FFmpeg
# release signing key (pinned by fingerprint; the key is committed as voice/ffmpeg-release-key.asc) and match the pinned sha256. The
# build is minimal and fully static: only the pipe protocol, the matroska/webm, mov/mp4/m4a and mp3 demuxers, the opus, aac, mp3 and
# vorbis decoders (+ their parsers), the aresample/aformat filters and the s16le muxer with the pcm_s16le encoder (those are exactly what
# buildFfmpegArgs needs). ogg is left out: yt-dlp's `-f bestaudio/best` on YouTube yields webm (opus/vorbis), m4a (aac) or mp4, and Edge
# TTS yields mp3; ogg is not in -format_whitelist either. No network code, no autodetected libraries, no GPL/nonfree parts.
# The compiled binary is not bit-reproducible across Alpine toolchain updates (the apk toolchain below is not pinned), so there is no
# fixed binary hash: the stage writes /opt/ffmpeg/ffmpeg.sha256 (root, 0444) and the boot check reads it (voice/binaries.ts).
# The S9 smoke at the end runs the production argv (buildFfmpegArgs) on voice/fixtures/ffmpeg-smoke and fails the build on any miss.
# make runs at most 2 jobs: lw-git builds under --memory 1536m, and -j$(nproc) on a many-core VPS could OOM the build.
FROM ${NODE_IMAGE} AS ffmpeg
ARG TARGETARCH
ARG FFMPEG_VERSION=9.0.2
ARG FFMPEG_SIGNER_FPR=FCF986EA15E6E293A5644F10B4322F04D67658D8
ARG FFMPEG_TAR_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
COPY voice/ffmpeg-release-key.asc /tmp/ffmpeg-release-key.asc
COPY voice/fixtures/ffmpeg-smoke /tmp/fx
RUN set -eu; \
    arch="${TARGETARCH:-}"; \
    if [ -z "$arch" ]; then case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) echo "unsupported machine $(uname -m)" >&2; exit 1 ;; esac; fi; \
    case "$arch" in amd64|arm64) ;; *) echo "unsupported TARGETARCH '$arch'" >&2; exit 1 ;; esac; \
    apk add --no-cache build-base curl gnupg pkgconf xz >/dev/null; \
    if [ "$(uname -m)" = x86_64 ]; then apk add --no-cache nasm >/dev/null; fi; \
    export GNUPGHOME="$(mktemp -d)"; \
    gpg --batch --quiet --import /tmp/ffmpeg-release-key.asc; \
    gpg --batch --with-colons --fingerprint | grep -q "^fpr:::::::::${FFMPEG_SIGNER_FPR}:"; \
    cd /tmp; base="https://ffmpeg.org/releases"; \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o src.tar.xz "$base/ffmpeg-${FFMPEG_VERSION}.tar.xz"; \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o src.tar.xz.asc "$base/ffmpeg-${FFMPEG_VERSION}.tar.xz.asc"; \
    gpg --batch --status-fd 1 --verify src.tar.xz.asc src.tar.xz 2>/dev/null | grep -q "^\[GNUPG:\] VALIDSIG .* ${FFMPEG_SIGNER_FPR}$"; \
    echo "${FFMPEG_TAR_SHA256}  src.tar.xz" | sha256sum -c -; \
    mkdir -p /build/ffmpeg; tar -xJf src.tar.xz -C /build/ffmpeg --strip-components=1; \
    cd /build/ffmpeg; \
    ./configure --prefix=/opt/ffmpeg-build --enable-static --disable-shared --disable-everything --disable-autodetect --disable-network \
      --disable-doc --disable-ffplay --disable-ffprobe --disable-debug --disable-stripping --extra-ldflags=-static \
      --enable-ffmpeg --enable-protocol=pipe \
      --enable-demuxer=matroska,mov,mp3 --enable-parser=aac,mpegaudio,opus,vorbis \
      --enable-decoder=aac,mp3,mp3float,opus,vorbis \
      --enable-filter=abuffer,abuffersink,aformat,anull,aresample --enable-muxer=pcm_s16le --enable-encoder=pcm_s16le; \
    jobs=$(nproc); if [ "$jobs" -gt 2 ]; then jobs=2; fi; make -j"$jobs" ffmpeg; \
    install -D -m 0755 -o root -g root ffmpeg /opt/ffmpeg/ffmpeg; \
    strip -s /opt/ffmpeg/ffmpeg; \
    if readelf -lW /opt/ffmpeg/ffmpeg | grep -q INTERP; then echo "ffmpeg has a dynamic interpreter, it is not static" >&2; exit 1; fi; \
    if readelf -dW /opt/ffmpeg/ffmpeg 2>/dev/null | grep -q NEEDED; then echo "ffmpeg has NEEDED libraries, it is not static" >&2; exit 1; fi; \
    readelf -hW /opt/ffmpeg/ffmpeg | grep "Type:"; \
    sha256sum /opt/ffmpeg/ffmpeg > /opt/ffmpeg/ffmpeg.sha256; \
    chown root:root /opt/ffmpeg/ffmpeg.sha256; chmod 0444 /opt/ffmpeg/ffmpeg.sha256; \
    echo "ffmpeg binary ${arch}: $(cat /opt/ffmpeg/ffmpeg.sha256)"; \
    /opt/ffmpeg/ffmpeg -hide_banner -version | head -1 | grep -Eq "^ffmpeg version ${FFMPEG_VERSION} "; \
    names() { awk 'f{print $2} /^ *-+ *$/{f=1}' | tr ',' '\n' | LC_ALL=C sort | tr '\n' ' '; }; \
    [ "$(/opt/ffmpeg/ffmpeg -hide_banner -demuxers | names)" = "3g2 3gp m4a matroska mj2 mov mp3 mp4 webm " ]; \
    [ "$(/opt/ffmpeg/ffmpeg -hide_banner -decoders | names)" = "aac mp3 mp3float opus vorbis " ]; \
    [ "$(/opt/ffmpeg/ffmpeg -hide_banner -muxers | names)" = "s16le " ]; \
    [ "$(/opt/ffmpeg/ffmpeg -hide_banner -encoders | names)" = "pcm_s16le " ]; \
    [ "$(/opt/ffmpeg/ffmpeg -hide_banner -protocols | awk '/^  [a-z]/ {print $1}' | LC_ALL=C sort -u | tr '\n' ' ')" = "pipe " ]; \
    ffargs='-hide_banner -loglevel error -format_whitelist matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mp3 -codec_whitelist opus,aac,mp3,mp3float,vorbis -protocol_whitelist pipe -i pipe:0 -vn -f s16le -ar 48000 -ac 2 pipe:1'; \
    /opt/ffmpeg/ffmpeg $ffargs < /tmp/fx/t.mp3 > /tmp/smoke.pcm; \
    [ "$(wc -c < /tmp/smoke.pcm)" -ge 30000 ]; \
    for f in t.wav hls-http.m3u8 hls-rtsp.m3u8; do \
      if /opt/ffmpeg/ffmpeg $ffargs < "/tmp/fx/$f" > /tmp/smoke.pcm 2>/dev/null; then echo "ffmpeg accepted $f" >&2; exit 1; fi; \
      [ "$(wc -c < /tmp/smoke.pcm)" -eq 0 ]; \
    done; \
    for u in http://127.0.0.1:1/x.mp3 rtsp://127.0.0.1:1/live; do \
      if /opt/ffmpeg/ffmpeg -hide_banner -loglevel error -protocol_whitelist pipe -i "$u" -f s16le - >/dev/null 2>&1; then echo "ffmpeg opened $u" >&2; exit 1; fi; \
    done

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --chown=root:root package.json ./
# P22 ffmpeg: only the statically linked binary and its hash manifest from the ffmpeg stage; no shared libraries come with it.
ARG FFMPEG_VERSION=9.0.2
COPY --from=ffmpeg --chown=root:root /opt/ffmpeg/ /opt/ffmpeg/
RUN /opt/ffmpeg/ffmpeg -hide_banner -version | head -1 | grep -Eq "^ffmpeg version ${FFMPEG_VERSION} " \
    && sha256sum -c /opt/ffmpeg/ffmpeg.sha256 \
    && mkdir -p /run/media-ipc && chown 10001:10001 /run/media-ipc && chmod 0755 /run/media-ipc
COPY --from=ytdlp --chown=root:root /opt/yt-dlp /opt/yt-dlp
# Code is root-owned and read-only to the runtime user; the `node` image user (uid 1000) is non-root.
# Gate 2 VULN-001: the app runs plain `node`; drop the bundled package managers (and their vendored, CVE-bearing
# deps) from the final stage only. The deps stage above still has npm to install production deps.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
# P18: mount point of the praw-workspace volume; a fresh named volume takes this owner and mode (0700, node).
RUN mkdir -p /app/data/workspace/praw && chown -R node:node /app/data && chmod 700 /app/data /app/data/workspace /app/data/workspace/praw
USER node
# No base docker-entrypoint.sh: its /bin/sh exec hands SHLVL and PWD to node, and the media sidecar (same image, compose `command`)
# refuses any env key outside ENV_ALLOW with exit 78. Kept before CMD: an ENTRYPOINT resets a CMD inherited from the base image, so CMD is restated after it.
ENTRYPOINT []
CMD ["node", "dist/main.js"]
