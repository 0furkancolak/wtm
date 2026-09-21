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

## Kapatma sırası (kota dönünce)

1. Actions dönünce her branch/PR'a **gerçek bir commit** ile taze bir CI tetikle (boş commit yok,
   `main`'i merge etmek yeter) — bu #35–#42'nin darwin/linux tarafını otomatik kapatır.
2. Yukarıdaki `win32_test_filter` dizelerini tek tek `workflow_dispatch` ile koştur (Kaptan'ın eli
   gerekiyor, bu ortamdan 403). Her biri kendi PR'ının açıklamasında zaten yazılı, bu belge onları
   tek yerde toplar.
3. #42 için ayrıca ilk gerçek `v0.2.0-rc.*` tag'i push'lanmalı — yalnızca o an `verify-linux`
   job'ı gerçekten çalışır.

## Bu kesintiyle ilgisi olmayan, önceden bilinen borç

`docs/superpowers/plans/2026-09-16-w2-win32-failure-clusters.md` zaten ayrı bir liste tutuyor:
gerçek Windows kernel'e karşı hiç ölçülmemiş kümeler (`gc.test.ts`'in `RESOURCE_CLEANUP_FAILED`
bulgusu gibi). Bu belge onunla çakışmıyor, tamamlıyor.
