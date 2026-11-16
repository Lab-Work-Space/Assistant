# Vendored fonts (RFMD P3, Gate 1 RF16)

Sarabun Regular and Bold (Thai + Latin), SIL Open Font License 1.1 (OFL.txt), from
https://github.com/google/fonts/tree/main/ofl/sarabun (Cadson Demak, Sarabun Project Authors, 2018).

The document renderer embeds these as `data:` URLs; no web font and no CDN is ever used. The sha256 of each file is pinned in
`tools/plugins/docs/fonts.ts` and listed in SHA256SUMS; a test fails when a file differs from the pin.
