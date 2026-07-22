# Changelog

## [0.19.1](https://github.com/kontourai/traverse/compare/v0.19.0...v0.19.1) (2026-07-22)


### Documentation

* content sweep — accuracy and clarity fixes ([#81](https://github.com/kontourai/traverse/issues/81)) ([b89f8d0](https://github.com/kontourai/traverse/commit/b89f8d07b82638ed9090fa449a6506593e0e5093))
* narrow raw-source locator profiles ([#87](https://github.com/kontourai/traverse/issues/87)) ([e488974](https://github.com/kontourai/traverse/commit/e48897483dda2b80b6cedf857d8b30f4dd2d3bd6))
* reconcile extraction baseline ([#85](https://github.com/kontourai/traverse/issues/85)) ([a47c28d](https://github.com/kontourai/traverse/commit/a47c28d1bfe7645cb5d048cb6226f210ccb416e3))

## [0.19.0](https://github.com/kontourai/traverse/compare/v0.18.0...v0.19.0) (2026-07-20)


### Features

* add portable extraction result envelope ([7f93999](https://github.com/kontourai/traverse/commit/7f939999a8a5e3c569ddf59f7002ff67d1b99dc6))
* add portable extraction result envelope ([6998a7a](https://github.com/kontourai/traverse/commit/6998a7a113bb2ed2b8a8c1930ab9aa257a77cdcb))

## [0.18.0](https://github.com/kontourai/traverse/compare/v0.17.0...v0.18.0) (2026-07-20)


### Features

* add bounded batch extraction ([820c709](https://github.com/kontourai/traverse/commit/820c70953ac8572d392aaee8beb91477bfb7af28))
* add bounded batch extraction ([27c497e](https://github.com/kontourai/traverse/commit/27c497eadd351bb9589ddd86df45390a5188ba3d))
* add versioned extraction task specs ([0b68581](https://github.com/kontourai/traverse/commit/0b6858110e5adfc56be7c342f22d8e6f555b960d))
* add versioned extraction task specs ([096be51](https://github.com/kontourai/traverse/commit/096be51496e8e1459ec7944a6ade62f5570a9774))
* bind extraction to prepared artifacts ([bab0658](https://github.com/kontourai/traverse/commit/bab06584b12a3089d3e5debdac394a5bf9392431))
* bind extraction to prepared artifacts ([9eb9c1c](https://github.com/kontourai/traverse/commit/9eb9c1c1f0d68bcb065faee7e8d27664a107647c))
* enforce provider extraction conformance ([be769b3](https://github.com/kontourai/traverse/commit/be769b35bf8f49538335f0825f793076bfd3a6c0))
* enforce provider extraction conformance ([eaf9b6f](https://github.com/kontourai/traverse/commit/eaf9b6fb128ccbe8ffcc2470ad7a69ab4b735cdb))
* **evals:** benchmark grounded extraction quality ([bc945e4](https://github.com/kontourai/traverse/commit/bc945e4ecff03625b6d07bf8adfb38fa0d2b97f0))
* **evals:** benchmark grounded extraction quality ([3229eb5](https://github.com/kontourai/traverse/commit/3229eb592be2526a1af17ed9bc74ac7f19dae77e))
* resolve exact excerpt occurrences ([19f832a](https://github.com/kontourai/traverse/commit/19f832a542fbfc4a8f50908d9c8bcad5dfd4c441))
* resolve exact excerpt occurrences ([cef0b0b](https://github.com/kontourai/traverse/commit/cef0b0b38db4104753f9cbe8b2fb034561fc8f3b))

## [0.17.0](https://github.com/kontourai/traverse/compare/v0.16.0...v0.17.0) (2026-07-15)


### Features

* default egress to forage's SSRF-guarded fetch (traverse[#41](https://github.com/kontourai/traverse/issues/41)) ([#58](https://github.com/kontourai/traverse/issues/58)) ([4ca0f3e](https://github.com/kontourai/traverse/commit/4ca0f3e8d5efe112c72faa0347821bb7582f0252))
* echo schema valueType/enumValues onto ExtractionProposal (traverse[#44](https://github.com/kontourai/traverse/issues/44)) ([#59](https://github.com/kontourai/traverse/issues/59)) ([fdf2279](https://github.com/kontourai/traverse/commit/fdf227951e54500dea9d39d95c5c694e86061f99))

## [0.16.0](https://github.com/kontourai/traverse/compare/v0.15.0...v0.16.0) (2026-07-14)


### Features

* crawlAndExtract composes forage.crawl + traverse.extract (traverse[#55](https://github.com/kontourai/traverse/issues/55)) ([#56](https://github.com/kontourai/traverse/issues/56)) ([bf83ded](https://github.com/kontourai/traverse/commit/bf83dedc0eb547b850223f4cd074568c0f74bff4))

## [0.15.0](https://github.com/kontourai/traverse/compare/v0.14.1...v0.15.0) (2026-07-12)


### Features

* render-escalation policy seam (never|always|on-shell-warning) ([#53](https://github.com/kontourai/traverse/issues/53)) ([af0b5e3](https://github.com/kontourai/traverse/commit/af0b5e3b52980852bc58ac7dccd23f18fd7719b8))

## [0.14.1](https://github.com/kontourai/traverse/compare/v0.14.0...v0.14.1) (2026-07-10)


### Fixes

* scope HTTP validators to resource identity ([#49](https://github.com/kontourai/traverse/issues/49)) ([#51](https://github.com/kontourai/traverse/issues/51)) ([3d5c778](https://github.com/kontourai/traverse/commit/3d5c77855f49194e36e5c0d706f7a7850a9e2be3))

## [0.14.0](https://github.com/kontourai/traverse/compare/v0.13.0...v0.14.0) (2026-07-07)


### Features

* optional ImageTextExtractor seam — OCR for image documents, mirroring PdfTextExtractor ([#47](https://github.com/kontourai/traverse/issues/47)) ([68979e1](https://github.com/kontourai/traverse/commit/68979e1a038431876aa172617b451923ade51cd0))

## [0.13.0](https://github.com/kontourai/traverse/compare/v0.12.0...v0.13.0) (2026-07-07)


### Features

* **fetch:** rendered-fetch seam — SPA/JS pages through fetchSource/crawlSource via pluggable renderImpl ([#44](https://github.com/kontourai/traverse/issues/44)) ([e7f1832](https://github.com/kontourai/traverse/commit/e7f18326253b60db04014e795335dc349f1479a2))

## [0.12.0](https://github.com/kontourai/traverse/compare/v0.11.0...v0.12.0) (2026-07-07)


### Features

* **fetch:** binary-safe Snapshot bodies (bodyBytes) + pdfTextExtractor forwarding in fetchAndExtract ([#42](https://github.com/kontourai/traverse/issues/42)) ([e656307](https://github.com/kontourai/traverse/commit/e656307bdf713b53b353e08eac5abd5b7efd6329))

## [0.11.0](https://github.com/kontourai/traverse/compare/v0.10.1...v0.11.0) (2026-07-06)


### Features

* **fetch:** crawlSource — bounded same-host crawl frontier (slice 1) ([43898ca](https://github.com/kontourai/traverse/commit/43898ca0f445f16d9f309453b3a36bd40fd8f3b3))
* **fetch:** crawlSource — bounded same-host crawl frontier (slice 1) ([#38](https://github.com/kontourai/traverse/issues/38)) ([f106e43](https://github.com/kontourai/traverse/commit/f106e43544282092c344c91d78c3b42e8d35aa59))

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
