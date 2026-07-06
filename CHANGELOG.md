# Changelog

## [0.10.1](https://github.com/kontourai/traverse/compare/v0.10.0...v0.10.1) (2026-07-06)


### Fixes

* **fetch:** forward maxProviderCalls/maxTotalTokens through fetchAndExtract ([c4505ba](https://github.com/kontourai/traverse/commit/c4505ba83e7705f63796b9980b52e6a3bcbf8f4c))
* **fetch:** forward maxProviderCalls/maxTotalTokens through fetchAndExtract ([#28](https://github.com/kontourai/traverse/issues/28)) ([05b9c1d](https://github.com/kontourai/traverse/commit/05b9c1ddcc20765040f43c4008515e8f4635b7bc))
* remove delivery trust bundle — content-boundary violation (private vertical names in public repo) ([17cd51b](https://github.com/kontourai/traverse/commit/17cd51ba7965ebacfe9c4b271338a2475a765d8e))

## [0.10.0](https://github.com/kontourai/traverse/compare/v0.9.0...v0.10.0) (2026-07-06)


### Features

* **fetch,content-prep:** YouTube/VTT transcript adapter + HTTP validators ([#31](https://github.com/kontourai/traverse/issues/31)) ([#32](https://github.com/kontourai/traverse/issues/32)) ([e3039b8](https://github.com/kontourai/traverse/commit/e3039b8687e8ee482a9f3e890ca1fd368add7b99))

## [0.9.0](https://github.com/kontourai/traverse/compare/v0.8.0...v0.9.0) (2026-07-04)


### Features

* **content-prep:** PDF extraction via injected PdfTextExtractor seam ([#26](https://github.com/kontourai/traverse/issues/26)) ([298e9ea](https://github.com/kontourai/traverse/commit/298e9ea1574d3e849f7d8da3bea7a0f41d6914f0)), closes [#21](https://github.com/kontourai/traverse/issues/21)
* **schema:** inferenceType — honest grounding semantics per field ([#29](https://github.com/kontourai/traverse/issues/29)) ([4c9a015](https://github.com/kontourai/traverse/commit/4c9a0153cc3eed2a7d192ee825841c46bab90f0f)), closes [#24](https://github.com/kontourai/traverse/issues/24)

## [0.8.0](https://github.com/kontourai/traverse/compare/v0.7.0...v0.8.0) (2026-07-03)


### Features

* **extract:** cost guards — maxProviderCalls and maxTotalTokens ceilings ([#19](https://github.com/kontourai/traverse/issues/19)) ([e3f9961](https://github.com/kontourai/traverse/commit/e3f99616c40c5376cf5be0a0c175d75173904c0a))

## [0.7.0](https://github.com/kontourai/traverse/compare/v0.6.0...v0.7.0) (2026-07-03)


### Features

* **docs:** freeze ADRs as immutable provenance; seed decision registry ([#17](https://github.com/kontourai/traverse/issues/17)) ([a94c4d6](https://github.com/kontourai/traverse/commit/a94c4d6a20755aa4aeffc27240c5c976a145b583))

## [0.6.0](https://github.com/kontourai/traverse/compare/v0.5.1...v0.6.0) (2026-07-03)


### Features

* embedded-state sidecar (JSON-LD / __NEXT_DATA__) + JS-shell warning ([#15](https://github.com/kontourai/traverse/issues/15)) ([4a19823](https://github.com/kontourai/traverse/commit/4a19823883371d457f8924c95583819e1512ef8b))

## [0.5.1](https://github.com/kontourai/traverse/compare/v0.5.0...v0.5.1) (2026-07-03)


### Fixes

* dedup on verified source span; keep prepareContent from throwing ([#12](https://github.com/kontourai/traverse/issues/12)) ([28207ee](https://github.com/kontourai/traverse/commit/28207eee2affcd7a292cdf9fbe83bea872f7a626))

## [0.5.0](https://github.com/kontourai/traverse/compare/v0.4.0...v0.5.0) (2026-07-03)


### Features

* large-page extraction via markdown prep + structural chunking ([#9](https://github.com/kontourai/traverse/issues/9)) ([21e1041](https://github.com/kontourai/traverse/commit/21e10418b7093ee00f88326c957492e5fdec50d8)), closes [#8](https://github.com/kontourai/traverse/issues/8)

## [0.4.0](https://github.com/kontourai/traverse/compare/v0.3.0...v0.4.0) (2026-07-03)


### Features

* normalize indexed field paths ([n] -&gt; []) against array schemas ([#6](https://github.com/kontourai/traverse/issues/6)) ([aa39194](https://github.com/kontourai/traverse/commit/aa391944c0bc4b6e11df14b6c5a144e833b8cadc)), closes [#5](https://github.com/kontourai/traverse/issues/5)

## [0.3.0](https://github.com/kontourai/traverse/compare/v0.2.0...v0.3.0) (2026-07-02)


### Features

* add configurable fetch + snapshot/replay foundation (Slice 2) ([#3](https://github.com/kontourai/traverse/issues/3)) ([71ed600](https://github.com/kontourai/traverse/commit/71ed6005a8ec87527b0ebacdc2e5f7f085580f0a))

## [0.2.0](https://github.com/kontourai/traverse/compare/v0.1.0...v0.2.0) (2026-07-02)


### Features

* support custom base URL for Anthropic-compatible endpoints ([#1](https://github.com/kontourai/traverse/issues/1)) ([c107dc7](https://github.com/kontourai/traverse/commit/c107dc74bc351a6d0f1cfacfa5d970daf81a2a40))
