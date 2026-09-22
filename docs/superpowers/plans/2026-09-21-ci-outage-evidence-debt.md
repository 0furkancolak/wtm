# 2026-09-21 GitHub Actions kesintisi — kanıt borcu envanteri

> Amaç: Actions kotası dönünce tek turda kapatılabilecek bir liste. Her satır bir PR/commit için
> hangi platform kanıtının alınmadığını ve (varsa) hedefli `win32_test_filter` dizesini verir.
> Bu belge yalnızca envanterdir — kod içermez, kimseyi bloklamaz.

## Kesinti penceresi

GitHub Actions hesap seviyesinde ~2026-09-21T07:39Z'den itibaren durdu: her job, her branch'te
(main'in kendi push'u dahil) birkaç saniyede `runner_id: 0` ile ("hiç runner atanmadı") düşüyor.
Sınır, `ci.yml` workflow run listesinin zamanlamasından doğrulandı:

- Son gerçek (tam süreli, runner atanmış) koşu: `claude/project-thread-nxcweb` dalı, run
  `35573041120`, 07:27:23Z'de başladı, 07:49:29Z'de `success` ile bitti — zaten çalışmaya başlamış
  bir runner kesintiden etkilenmedi.
- İlk kesinti imzası: `claude/project-thread-4jimeq-w4-2` dalı, run `35574057890`, 07:40:16Z
  başladı, 07:40:43Z bitti (`failure`, 27 sn).
- Bu andan sonra her koşu aynı imzayı taşıyor: 7-8 saniyede `failure`, tüm leg'ler aynı anda.

Bu belge yalnızca **bu kesinti yüzünden** kanıtsız kalan PR'ları listeler. Kesintiden önce
gerçek CI ile kapanan PR'lar (#28–#34) kapsam dışı — onların borcu yalnızca önceden bilinen,
ayrı bir konu olan gerçek Windows kernel kanıtı (`win32_test_filter` dispatch'i, bu kesintiyle
ilgisiz, repo'nun standart Windows doğrulama süreci).

## Kesinti sırasında yerel gate ile birleşen PR'lar

Hepsi `bun run typecheck && bun run lint && bun run test` ile doğrulandı (bu sandbox'ın bilinen
iki uid-0 hatası hariç: `daemon/__tests__/main.test.ts`, `daemon/__tests__/server.integration.test.ts`).
Hiçbirinde darwin/linux/win32 için gerçek CI koşusu yok.

### #35 — fix(platform,core,cli,daemon): resolve a command name against PATHEXT on win32
- Commit: `a7d5a1d` · Unit: W4-2 / 9g
- Eksik kanıt: darwin, win32 (gerçek Windows kernel)
- Hedefli `win32_test_filter`:
  ```
  packages/cli/src/__tests__/refresh-remotes.test.ts packages/cli/src/__tests__/main.test.ts packages/cli/src/__tests__/remove-runtime.test.ts packages/daemon/src/__tests__/ci-watch-scenario.test.ts packages/platform/src/exec/__tests__/executable-path.test.ts packages/core/src/git/__tests__/git-executable-resolver.test.ts
  ```

### #36 — fix(platform,daemon): construct a Windows service lifecycle without a POSIX uid
- Commit: `14fdbe9` · Unit: W4-3 / 9i
- Eksik kanıt: darwin, win32 (gerçek Task Scheduler / `schtasks.exe`)
- Hedefli `win32_test_filter`:
  ```
  packages/platform/src/service/__tests__/windows-service.test.ts packages/daemon/src/__tests__/scheduled-task.test.ts packages/cli/src/commands/__tests__/daemon.test.ts
  ```
- Not: "PowerShell install/uninstall ve completion, Git Bash testi" alt-alanları PR'da kasıtlı
  olarak dışarıda bırakıldı — win32 failure-clusters dokümanı bu alanlarda hiç gözlemlenmiş hata
  kaydetmiyor.

### #37 — test(cli): assert the platform-appropriate outcome of a rename-race test
- Commit: `514eb1e` · Unit: skill.test.ts fixture sweep'in devamı (9f kümesi)
- Eksik kanıt: darwin, win32 (bu değişikliğin kendisi bir önceki win32 koşusundaki gerçek `EPERM`
  bulgusuna dayanıyor ama bu commit'in kendisi hiç koşmadı)
- Hedefli `win32_test_filter`:
  ```
  packages/cli/src/commands/__tests__/skill.test.ts
  ```

### #38 — test(daemon): prove two daemons under different HOMEs run at once (35d)
- Commit: `66e6e40` · Unit: W4-4 / 35d
- Eksik kanıt: darwin, win32 — ama kod kendi platform dalı taşımıyor (yalnızca mevcut
  `@wtm/platform` seçimini kullanıyor), yani özel bir hedefli filtreye ihtiyacı yok; genel CI
  dönünce otomatik kapanır.
- Hedefli `win32_test_filter` (isteğe bağlı, hızlı doğrulama için):
  ```
  packages/daemon/src/__tests__/dual-home-daemons.test.ts
  ```

### #39 — test(daemon): use a real foreign ACE for the unsafe-parent scenario
- Commit: `892ba93` · Unit: 9f fixture sweep'in devamı
- Eksik kanıt: darwin, win32 (gerçek NTFS ACE)
- Hedefli `win32_test_filter`:
  ```
  packages/daemon/src/__tests__/runtime-factory.test.ts
  ```
  (`private-database.scenario.ts`'i bu dosya üzerinden çalıştırıyor.)

### #40 — test: close remaining lifecycle parity gaps (W5-4 / 35a)
- Commit: `31e22f1` · Unit: W5-4 / 35a
- Eksik kanıt: darwin, linux (gerçek CI, sandbox yalnızca Linux'u ölçtü), win32
- Hedefli `win32_test_filter`:
  ```
  packages/cli/src/__tests__/lifecycle-events-daemon.test.ts packages/core/src/analysis/__tests__/cleanup-ranking.test.ts
  ```

### #41 — test(core,cli): prove the daemon JSON contract's cross-platform shape (W5-3 / 9m)
- Commit: `a401b46` · Unit: W5-3 / 9m
- Eksik kanıt: darwin, win32 — bu PR'ın kendisi *fixture* kanıtı üretti (üç platform kimliği bu
  Linux sandbox'ta enjekte edildi), gerçek bir Windows/macOS kernel'e karşı hiç çalışmadı.
  `daemon.test.ts`'e eklenen dört yeni test zaten üç platformu da fixture olarak kapsıyor; gerçek
  koşu yalnızca doğrulama, yeni bulgu beklenmiyor.
- Hedefli `win32_test_filter`:
  ```
  packages/cli/src/commands/__tests__/daemon.test.ts packages/core/src/config/__tests__/cross-platform-config.test.ts
  ```

### #42 — feat(release): publish Linux x64 and arm64 archives on a tag (W5-2 / 29a)
- Commit: `b9adc1a` · Unit: W5-2 / 29a
- Eksik kanıt: **gerçek tag push'u hiç yapılmadı** — `release.yml`'deki yeni `verify-linux` job'ı
  bir CI koşusunda hiç çalışmadı. Bu bir `win32_test_filter` meselesi değil (release.yml
  `workflow_dispatch` almıyor, yalnızca `v*` tag push'unda tetikleniyor); kanıt yalnızca gerçek bir
  release tag'i ile gelir. Actions dönünce ilk prerelease tag'inde otomatik doğrulanır.
- Ayrıca darwin/win32 genel CI kanıtı da yok (aynı kesinti).

### #45 — feat(release,scripts): add a Windows x64 zip release target (W6-1 / 29b)
- Commit: `255fd79` · Unit: W6-1 / 29b
- Eksik kanıt: **gerçek `windows-latest` runner'da hiç çalışmadı** — `verify-windows` job'ı, PE
  header doğrulaması ve `Compress-Archive` zip'lemesi yalnızca sahte PE fixture'larıyla, bu Linux
  sandbox'ta doğrulandı. `release.yml` `workflow_dispatch` almadığı için bu bir
  `win32_test_filter` meselesi değil; kanıt yalnızca gerçek bir release tag'i ile gelir.
- Ayrıca darwin/linux genel CI kanıtı da yok (aynı kesinti).

### #46 — fix(release): make the Windows archive optional in the whole-release gate
- Commit: `e07f317` · #45'in düzeltmesi
- Eksik kanıt: aynı — `requiredReleaseTargets`/`continue-on-error` mantığı yalnızca yerel gate ve
  yapısal testlerle doğrulandı, gerçek bir Windows leg'in başarısız olup release'in geri kalanını
  bloklamadığı bir tag'de hiç görülmedi.

### #50 — feat(core,daemon,cli): DB-backed task overrides (W6-2 / 49)
- Commit: `3018ce1` · Unit: W6-2 / 49 (kapsamı genişletilerek W7-2/W7-3'ün `wtm task` CLI ailesini
  ve `wtm remove` temizliğini de kapsadı)
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası: 5 `Validate` leg'i saniyeler içinde, runner atanmadan
  düştü). Yalnızca yerel gate ile doğrulandı.
- Hedefli `win32_test_filter`:
  ```
  packages/cli/src/__tests__/decisions.test.ts packages/cli/src/__tests__/remove-runtime.test.ts packages/cli/src/commands/__tests__/task.test.ts packages/core/src/config/__tests__/merge.test.ts packages/core/src/state/__tests__/assets.test.ts packages/core/src/state/__tests__/sqlite-store.test.ts packages/core/src/state/__tests__/task-overrides.test.ts packages/daemon/src/__tests__/task-override-resolution.test.ts packages/daemon/src/__tests__/task-overrides-handler.test.ts packages/protocol/src/__tests__/task-overrides.test.ts
  ```

### #51 — feat(daemon,core): automatic idle runtime suspension for managed tasks (W8-3 / 14)
- Commit: `b2771f1` · Unit: W8-3 / 14
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  hiç çalışmadı (`get_check_runs` 0 döndü, runner atanmadı). Yalnızca yerel gate ile doğrulandı.
- Hedefli `win32_test_filter`:
  ```
  packages/daemon/src/__tests__/idle-runtime.test.ts packages/core/src/config/__tests__/idle-config.test.ts packages/daemon/src/__tests__/runtime-controller.test.ts packages/daemon/src/__tests__/logs.test.ts
  ```

### #52 — feat(cli,core): add wtm init --preset for seven starter workspaces (W9-2 / 20)
- Commit: `4533596` (öncesi) → merge sonrası güncel head · Unit: W9-2 / 20
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — bu branch'te de
  `ci.yml` hiç çalışmadı (aynı kesinti imzası: tüm leg'ler saniyeler içinde, boş çıktıyla düşüyor).
  Yalnızca yerel gate ile doğrulandı.
- Hedefli `win32_test_filter`:
  ```
  packages/core/src/workspace/__tests__/init.integration.test.ts packages/cli/src/commands/__tests__/init.test.ts scripts/__tests__/examples-portability.test.ts
  ```

### #54 — feat(core,daemon,cli): PR awareness in wtm status (W6-3 / 13)
- Commit: `e390c7c` · Unit: W6-3 / 13 (K4)
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası). Yalnızca yerel gate ile doğrulandı.
- Bu PR'a özgü ayrı bir kanıt boşluğu yok: `gh` çağrısı testlerde her zaman sahte
  (`ciProvider` seam), gerçek ağ veya gerçek `gh` hiç kullanılmıyor.
- Hedefli `win32_test_filter`:
  ```
  packages/cli/src/__tests__/main.test.ts packages/cli/src/__tests__/state-diagnostics.test.ts packages/daemon/src/ci/__tests__/github-provider.test.ts packages/protocol/src/__tests__/ci.test.ts
  ```

### #55 — feat(cli): install.sh and install.ps1 standalone-binary installers (W8-2 / 24)
- Commit: `3dc748e` · Unit: W8-2 / 24
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası: 5 `Validate` leg'i saniyeler içinde, boş çıktıyla,
  runner atanmadan düştü). Yalnızca yerel gate ile doğrulandı.
- Bu PR'a özgü ayrı bir kanıt boşluğu: `install.ps1` gerçek `pwsh`/`powershell` ile hiç
  çalıştırılmadı (sandbox'ta yok, yalnızca yapısal kontrol yapıldı), ve bu depodan hiçbir tag
  Linux/Windows arşivi yayımlamadı (yalnızca macOS'lu `v0.1.0-rc.1` var) — `install.sh`'ın Linux
  yolu ve `install.ps1`'in tamamı gerçek bir release'e karşı hiç sınanmadı. Yerel `Bun.serve`
  fixture testi bunun yerini tutmaz, yalnızca protokolü doğrular.
- Hedefli `win32_test_filter`: yok — `install.ps1` için gerçek kanıt yalnızca gerçek bir Windows
  makinesinde elle veya bir sonraki Windows CI tetiklemesinde manuel `.\install.ps1` çalıştırmakla
  gelir, mevcut `win32_test_filter` mekanizması bu depo kökü script'lerini kapsamıyor.

### #56 — feat(core,cli): revoke adapter trust deliberately (W10-3 / 21)
- Commit: `df55a71` · Unit: W10-3 / 21
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası: 5 `Validate` leg'i 3-6 saniyede, `runner_id: 0` ile,
  runner atanmadan düştü). Yalnızca yerel gate ile doğrulandı.
- Hedefli `win32_test_filter`:
  ```
  packages/core/src/plan/__tests__/adapter-trust.test.ts packages/core/src/state/__tests__/sqlite-store.test.ts packages/cli/src/commands/__tests__/adapter.test.ts
  ```

### #57 — feat(daemon,core): local reverse proxy backend and hostname allocation (W9-4 / 12b)
- Commit: `a8f9ccb` · Unit: W9-4 / 12b
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası: 5 `Validate` leg'i saniyeler içinde, boş çıktıyla,
  runner atanmadan düştü). Yalnızca yerel gate ile doğrulandı.
- Bu PR'a özgü ayrı bir kanıt boşluğu: proxy loopback-only bind ve WebSocket/HMR upgrade
  splicing yalnızca bu Linux sandbox'ında, sahte bir backend'e karşı test edildi — gerçek bir
  macOS/Windows makinesinde, gerçek bir dev server'a (Vite HMR gibi) karşı hiç çalıştırılmadı.
- Hedefli `win32_test_filter`:
  ```
  packages/core/src/runtime/__tests__/proxy-hostname.test.ts packages/daemon/src/__tests__/proxy.test.ts packages/daemon/src/__tests__/proxy-routes.test.ts packages/core/src/config/__tests__/schema.test.ts
  ```

### #58 — feat(adapter-sdk,docs): add an adapter SDK, authoring guide and test harness (W10-2 / 21)
- Commit: `f39ec7c` · Unit: W10-2 / 21
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası: 5 `Validate` leg'i 3-7 saniyede, `runner_id: 0` ile,
  runner atanmadan düştü). Yalnızca yerel gate ile doğrulandı.
- Hedefli `win32_test_filter`:
  ```
  packages/adapter-sdk/src/__tests__/index.test.ts packages/adapter-sdk/src/testing/__tests__/invoke-adapter.test.ts
  ```

### #59 — fix(core): strip refs/heads/ before slugging a worktree's proxy hostname
- Commit: `1223d1b` (öncesi) → merge sonrası güncel head · #57'nin (W9-4) düzeltmesi
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası). Yalnızca yerel gate ile doğrulandı.
- Hedefli `win32_test_filter`:
  ```
  packages/core/src/runtime/__tests__/proxy-hostname.test.ts
  ```

### #60 — feat(daemon,core): join proxy hostnames into the CORS allowlist (W10-1 / 12c CORS half)
- Commit: `6ccaf1a` (öncesi) → merge sonrası güncel head · Unit: W10-1 / 12c (CORS yarısı)
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası). Yalnızca yerel gate ile doğrulandı.
- Hedefli `win32_test_filter`:
  ```
  packages/daemon/src/__tests__/proxy-cors-integration.test.ts
  ```

### #61 — feat(core,daemon,protocol): resource budgets admission gate (W9-1 / 19)
- Commit: `78fc6d2` · Unit: W9-1 / 19
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası: 5 `Validate` leg'i 4-6 saniyede, `runner_id: 0` ile,
  runner atanmadan düştü). Yalnızca yerel gate ile doğrulandı.
- Bu PR'a özgü ayrı bir kanıt boşluğu yok: `[budgets]` admission kontrolü platforma özel hiçbir
  şey yapmıyor (host bellek okuması zaten `job-memory.ts` üzerinden Node/libuv'a devrediliyor,
  W6-2'nin ağır iş kuyruğu tarafından zaten gerçek platformlarda dolaylı olarak egzersiz edilen
  aynı kod yolu).
- Hedefli `win32_test_filter`:
  ```
  packages/core/src/config/__tests__/schema.test.ts packages/daemon/src/__tests__/runtime-controller.test.ts packages/daemon/src/__tests__/budgets-composition.test.ts packages/protocol/src/__tests__/errors.test.ts packages/cli/src/__tests__/exit-codes.test.ts
  ```

### #65 — feat(daemon,core): inject dev overlay into proxied HTML responses (W10-4 / 46)
- Commit: `e47b4ef` (öncesi) → merge sonrası güncel head · Unit: W10-4 / 46 (MVP slice —
  kontrol listesi hariç)
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası). Yalnızca yerel gate ile doğrulandı.
- Bu PR'a özgü ayrı bir kanıt boşluğu: enjeksiyon `ProxyServer`'ın kendi response akışına
  eklendi, bu yüzden #57'nin (W9-4) zaten taşıdığı aynı "gerçek bir dev server'a (Vite HMR gibi)
  karşı hiç çalıştırılmadı" boşluğunu miras alıyor — sahte bir `http.Server` backend'e karşı
  test edildi.
- Hedefli `win32_test_filter`:
  ```
  packages/daemon/src/__tests__/dev-overlay.test.ts packages/daemon/src/__tests__/proxy-dev-overlay.test.ts packages/daemon/src/__tests__/proxy-policy.test.ts packages/core/src/config/__tests__/schema.test.ts
  ```

### #66 — feat(adapters): add workspace-here:<target> make task family (item 48)
- Commit: `c499b94` · Unit: madde 48 (P2 backlog taraması, koordinatör talimatıyla)
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası: 5 `Validate` leg'i 6-8 saniyede, runner atanmadan düştü).
  Yalnızca yerel gate ile doğrulandı (`packages/adapters` 42/42 dahil).
- Bu PR'a özgü ayrı bir kanıt boşluğu: `make -f <path>` argümanı `{workspace.root}/<ad>` şeklinde
  ileri taksim işaretiyle kuruluyor; Windows'ta `make` genellikle MSYS2/Git Bash altından
  çalıştığı için bu muhtemelen sorunsuz ama gerçek Windows'ta hiç egzersiz edilmedi.
- Hedefli `win32_test_filter`:
  ```
  packages/adapters/src/__tests__/make-plan.test.ts
  ```

### #69 — feat(core,protocol,daemon,cli): add the dev-overlay checklist (W11-1 / 46b)
- Commit: `2dcf096` (öncesi) → merge sonrası güncel head · Unit: W11-1 / 46b — madde 46'nın son
  açık parçası, kapatıyor.
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası). Yalnızca yerel gate ile doğrulandı.
- Bu PR'a özgü ayrı bir kanıt boşluğu: yeni proxy-native HTTP ucu (`/__wtm/checklist`) ve overlay'in
  ilk gerçek inline `<script>`'i yalnızca sahte bir backend'e karşı, bu Linux sandbox'ında test
  edildi — gerçek bir tarayıcıda (checkbox tıklama, fetch() davranışı) hiç çalıştırılmadı.
- Hedefli `win32_test_filter`:
  ```
  packages/core/src/state/__tests__/checklist.test.ts packages/protocol/src/__tests__/checklist.test.ts packages/daemon/src/__tests__/checklist-handler.test.ts packages/daemon/src/__tests__/proxy-checklist-api.test.ts packages/daemon/src/__tests__/dev-overlay.test.ts packages/cli/src/commands/__tests__/checklist.test.ts
  ```

### #72 — feat(cli): add wtm tui — worktree/task/port/health dashboard (item 15, unit 1/3)
- Commit: `ca3e3a9` · Unit: madde 15, birim 1/3.
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası: 5 leg 8-13 saniyede, runner atanmadan düştü). Yalnızca
  yerel gate ile doğrulandı (273 dosya, bu sandbox'ın bilinen 2 uid-0 hatası hariç).
- Bu PR'a özgü ayrı bir kanıt boşluğu: `wtm tui`'nin dış döngüsü (raw mode, alt-screen, cursor
  gizleme, `SIGINT`/`SIGTERM` işleyicileri, resize) hiç gerçek bir TTY'ye karşı çalıştırılmadı —
  yalnızca saf `view-model.ts`/`render.ts`/`command.ts` fonksiyonları test edildi. Bu, terminal
  lifecycle kodunun kendisi için gerçek bir kanıt boşluğu (kesintiyle ilgisiz, ayrı bir konu):
  gerçek bir terminalde (macOS/Linux/Windows, farklı `TERM`/boyut) elle doğrulama henüz yapılmadı.
- Hedefli `win32_test_filter`:
  ```
  packages/cli/src/tui/__tests__/view-model.test.ts packages/cli/src/tui/__tests__/render.test.ts packages/cli/src/tui/__tests__/command.test.ts packages/cli/src/__tests__/main.test.ts
  ```

### #73 — feat(cli): add disk usage / cleanup-candidate panel to wtm tui (item 15, unit 2/3)
- Commit: `cb190b5` · Unit: madde 15, birim 2/3.
- Eksik kanıt: darwin, linux (gerçek CI), win32 (gerçek Windows kernel) — `ci.yml` bu branch'te
  de hiç çalışmadı (aynı kesinti imzası: 5 leg 7-10 saniyede, runner atanmadan düştü). Yalnızca
  yerel gate ile doğrulandı (274 dosya, bilinen 2 uid-0 hatası hariç).
- Bu PR'a özgü ayrı bir kanıt boşluğu: yeni panelin ~15 saniyelik yavaş yenileme kadansı
  (`defaultResourceRefreshEveryNTicks`) yalnızca kod okumayla doğrulandı, gerçek bir TTY'de uzun
  süre açık bırakılıp elle gözlemlenmedi — #72'nin aynı kategorideki dış-döngü boşluğuyla aynı,
  kesintiyle ilgisiz.
- Hedefli `win32_test_filter`:
  ```
  packages/cli/src/tui/__tests__/resources-view.test.ts packages/cli/src/tui/__tests__/render.test.ts packages/cli/src/__tests__/main.test.ts
  ```

## Kapatma sırası (kota dönünce)

1. Actions dönünce her branch/PR'a **gerçek bir commit** ile taze bir CI tetikle (boş commit yok,
   `main`'i merge etmek yeter) — bu #35–#42'nin darwin/linux tarafını otomatik kapatır.
2. Yukarıdaki `win32_test_filter` dizelerini tek tek `workflow_dispatch` ile koştur (Kaptan'ın eli
   gerekiyor, bu ortamdan 403). Her biri kendi PR'ının açıklamasında zaten yazılı, bu belge onları
   tek yerde toplar.
3. #42 ve #45/#46 için ayrıca ilk gerçek `v0.2.0-rc.*` tag'i push'lanmalı — yalnızca o an
   `verify-linux` ve `verify-windows` job'ları gerçekten çalışır (`release.yml`
   `workflow_dispatch` almıyor).

## Bu kesintiyle ilgisi olmayan, önceden bilinen borç

`docs/superpowers/plans/2026-09-16-w2-win32-failure-clusters.md` zaten ayrı bir liste tutuyor:
gerçek Windows kernel'e karşı hiç ölçülmemiş kümeler (`gc.test.ts`'in `RESOURCE_CLEANUP_FAILED`
bulgusu gibi). Bu belge onunla çakışmıyor, tamamlıyor.
