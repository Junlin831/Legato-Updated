# Self-hosted display fonts

These fonts render the "playful" spots called out in the design system —
project title and chord symbols — in three visual modes selected per project:

- **Sci-Fi mode (default)** — `Orbitron-Bold.woff2`. Loaded as `Orbitron` in
  CSS. Matches the cosmic/constellation treatment of the sheet-music surface.
  Ships only in 700/800 (no italic).
- **JazzText mode** — `MuseJazzText.otf`. MuseScore's hand-lettered jazz
  chord-symbol text font. Loaded as `MuseJazz Text` in CSS.
- **Classical mode** — `Edwin-*.otf`. MuseScore 4's default engraver text
  font (Century-Schoolbook lineage). All four weights (Roman, Bold, Italic,
  BoldItalic) ship as a single `Edwin` family so callers can pick any
  weight/style. Chord symbols currently render in Bold (700 upright).

All three are SIL Open Font License 1.1; the license files
(`Orbitron-LICENSE.txt`, `MuseJazz-OFL.txt`, `Edwin-LICENSE.txt`) ship next
to the font files as required by OFL §5. Sources:
https://github.com/musescore/MuseScore (MuseJazz Text, Edwin) and
https://github.com/theleagueof/orbitron (Orbitron, via Google Fonts).

`js/sheet-music/particles.js`'s `FONT_SOURCES` map must know about any chord
font that can appear on the sheet music — it fetches and base64-embeds the
face into the rasterized SVG the particle system samples from, since that
isolated document can't see the page's own `@font-face` rules.
