# Kalan işler — 4 slotlu subagent dalga planı

> Kaynak: `todo.md` (main `fb0bede` + PR #11), 2026-09-15 envanteri. Bu belge yalnızca plan; geliştirme içermez.
> Hedef: `v0.2.0` (bkz. `todo.md` → "Release checklist — v0.2.0").

## 1. Çalışma modeli

**4 slot, sıralı kuyruk.** Aynı anda en fazla 4 implementer subagent çalışır. Her biri kendi git worktree'sinde, tek bir iş birimini (aşağıda `W<dalga>-<no>`) yapar ve tek PR üretir. Dalgalar kuyruk sırasıdır. Bir birim birleşince slotu boşalır. Slota, bağımlılıkları birleşmiş ve kod çakışma alanı boş olan sıradaki birim girer. Bir dalga, önceki dalganın dört birimi bitmeden de başlayabilir, yeter ki bu iki koşul sağlansın.

### 1.1 Birim başına akış

1. **Hazırlık (controller):**
   - `.worktrees/<birim>` worktree'sini ve `claude/<birim>` branch'ini `origin/main`'den aç.
   - Brief dosyasını yaz. İçinde şunlar olsun: todo satır aralığı, kabul kriterleri, dokunulacak dosyalar, önceden atanmış migration numarası ve global kısıtlar (§4).
2. **Implementer subagent (arka planda):**
   - Model: brief tam kod içeriyorsa ve iş tek dosyaysa sonnet; birden fazla dosya ya da tasarım yargısı gerekiyorsa opus.
   - TDD ile çalışır, commit atar ve raporu dosyaya yazar.
   - Başka subagent başlatmaz. Push etmez.
3. **İnceleme (subagent):**
   - `review-package BASE HEAD` diff dosyasını okur.
   - İki karar verir: spec uyumu ve kod kalitesi.
   - Model: küçük ya da mekanik diff için sonnet; eşzamanlılık, süreç yönetimi, Windows veya güvenlik içeren diff için opus.
4. **Düzenleme:**
   - Critical ve Important bulgular için en fazla 3 düzeltme turu yapılır; implementer'a resume ile devam ettirilir.
   - Her turdan sonra kapsamı dar bir yeniden inceleme yapılır.
   - Tur 4–5'e kalan bulgular için bir üst modelle yeni bir implementer açılır.
   - Minor bulgular ya düzeltilir ya da gerekçesiyle ledger'a park edilir.
5. **Gate (controller):**
   - Çalışacak komut: `bun run typecheck && bun run lint && bun run test`. Süre `perl -e 'alarm 1200; exec @ARGV'` ile sınırlanır. Log scratchpad'e yazılır.
   - **Makine başına aynı anda tek gate çalışır.** 4 slottan gelen gate'ler sıraya girer.
6. **PR:**
   - Push et, PR'ı aç.
   - PR gövdesi özet, verdikler/kararlar ve doğrulama içerir. Son satırı `🤖 Generated with [Claude Code](https://claude.com/claude-code)` olur.
7. **CI:**
   - Birleştirme koşulu: head commit'te win32 dışındaki tüm job'lar yeşil.
   - Windows birimleri (W2–W5 arası `9x`): ayrıca win32 leg'inde hedef test grubunun yeşil kanıtı gerekir (bkz. W1-4).
   - Bilinen kararsız testler W1-1 ve W1-2 birleşene kadar, düşen job **bir kez** yeniden çalıştırılabilir.
8. **Merge:**
   - Onay politikası (§5): kullanıcı dalga başında onay verir.
   - Birleştirmeden önce branch'e `origin/main` birleştirilir. todo.md veya doküman çakışmaları controller tarafından çözülür, gerekirse gate yeniden çalıştırılır.
9. **Temizlik:**
   - Worktree'yi, yerel branch'i ve uzak branch'i sil.
   - SDD workspace'ini sil.
   - Slot boşalır ve sıradaki uygun birim başlar.

### 1.2 Çakışma kuralları

- **Kod sıcak noktaları** paralel birimlerde çakışmaz. Aynı anda iki birim aynı modüle dokunamaz. Modüller:
  - `packages/daemon/src/process-supervisor.ts` ve `process-anchor.ts`;
  - IPC client/server ve runtime-factory;
  - `platform/src/trust/*`;
  - `platform/src/paths`;
  - task resolution + `explain.ts` + `adapters/src/make.ts`;
  - `.github/workflows/release.yml`;
  - `.github/workflows/ci.yml`.
- **Doküman sıcak noktaları** paralel olabilir, ama birleştirme sırayla yapılır. İkinci PR birleşmeden önce main'i alıp çakışmayı çözer. Bu dosyalar: `docs/03`, `docs/04`, `docs/06`, `docs/18`, `skills/wtm/SKILL.md`, `README.md` ve `CHANGELOG.md`.
- **`SKILL.md` 24 KiB bütçesi:** SKILL.md'ye ekleme yapan birim, birleşmeden önce `skill-reference.test.ts`'i main'le birlikte yeniden çalıştırır.
- **Migration numaraları önceden atanır:**
  - 016 → W6-2 (49a);
  - 017 → W6-3 (13), yalnızca tablo gerekirse;
  - 018 → W8-3 (14), yalnızca tablo gerekirse;
  - 019 → W9-1 (19), yalnızca tablo gerekirse.
  - Atanan numarayı kullanmayan birim numarayı boş bırakmaz: sonraki birim onu devralır ve controller brief'i günceller.
- **todo.md:** her birim yalnızca kendi maddesinin satırlarını işaretler. Başlık `[x]` yapma ve "Release checklist" satırları controller'ındır.

## 2. Başlamadan önce kullanıcı kapıları

Aşağıdakiler subagent'ın yapamayacağı ya da kullanıcının karar vermesi gereken işlerdir. Dalgaları **bloklamazlar**. Karar istenen maddeler, o maddeyi içeren dalga başlamadan önce tek toplu soruyla sorulur.

### 2.1 Kullanıcı eylemleri (hesap, secret, manuel doğrulama)
| id | İş | Açtığı birimler |
|---|---|---|
| 5a | Apple notarization secret'ları ve bir tag push'u | 5b, 36, R2 |
| 38a | npm 2FA kontrolü, ilk `@next` publish, provenance görünürlüğü | 23, 28, 35e, R6 |
| 38b | npm Trusted Publishing (OIDC) kurulumu, token süresi 2026-11-29'da doluyor | release.yml değişikliği (W7 sonrası tek birim) |
| 22 | GitHub repo açıklaması ve topics (`gh repo edit`, herkese açık ayar) | — |
| 30a | Homebrew tap reposu | Homebrew formula yayını |
| 30b | Scoop / WinGet manifest hesapları | — |
| 50a | İki gerçek AI oturumuyla RAM ölçümü; Linux ve Windows ölçümleri | 50 kapanışı |
| 35e / R6 | Temiz makinede curl+tar, npm, tarayıcıdan indirilmiş binary, Homebrew kurulumu | release kapanışı |

### 2.2 Tasarım kararları (ilgili dalgadan önce sorulacak)
| Karar | Soru | Dalga |
|---|---|---|
| K1 | Madde 2: `repair` komutu v0.2.0 kapsamında mı, yoksa madde kapsam dışı olarak mı kapatılacak? | W2 öncesi |
| K2 | 9m / D11: `plistPath` alanı kaldırılsın mı (breaking) yoksa macOS'a özel ek alan olarak kalsın mı? | W5 öncesi |
| K3 | 49: DB kaydı ile `wtm.toml` arasında öncelik; scope (workspace/repo/worktree); export; trust kaydı | W6 öncesi |
| K4 | 13: PR farkındalığı `wtm status`'ta mı, ayrı komutta mı? Ağ çağrısı açık bir bayrakla mı? | W6 öncesi |
| K5 | 48: isim alanı (`make:` / `workspace:` / worktree bağlamı) ve enjekte edilen değişken seti | W8 öncesi |
| K6 | 14: idle suspension varsayılan kapalı; resume stratejisi; interactive/debug istisnası | W8 öncesi |
| K7 | 50b ve 19: tahmine dayalı kabul ile OS hard limit ayrımı, ortak muhasebe | W8 öncesi |
| K8 | 12a: domain adlandırma, HTTPS/sertifika, CORS (spec onayı) | W9 öncesi |
| K9 | 20 presets ve 21a adapter kontrat versiyonlama | W9 öncesi |
| K10 | 46: enjeksiyon katmanı, opt-in/opt-out, 12'yi bekleme kararı | W10 öncesi |
| K11 | 15 (TUI/menu bar): v0.2.0 dışı mı? | W11 öncesi |
| K12 | GC sandbox/storage-object yazma yolu (`materializer.ts`/`guard.ts`'in üretim çağrı yeri) v0.2.0 kapsamına alınsın mı? | 2026-09-22 (v0.2.0 sonrası, karar: hayır — bkz. `2026-09-21-release-readiness-audit.md`'nin "K12" bölümü) |

## 3. Dalgalar

Her dalga 4 birimdir. "Bağ." sütunu, birleşmiş olması gereken birimleri gösterir. "Model" implementer modelidir; reviewer seçimi §1.1'e göre yapılır.

### W1 — CI'ı güvenilir yap
Kararsız testler ve Windows geri bildirim döngüsü, diğer bütün dalgaları hızlandırır.

| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W1-1 | F1 + 9l: process-supervisor "daemon close leaves the anchor-owned writer rotating…" testini koşula dayalı hale getir. macOS Intel'deki stale identity regresyonunu doğrula. | — | daemon supervisor testleri | opus |
| W1-2 | F2: runtime-factory "default CLI client reaches the isolated production IPC address…" `RUNTIME_PROCESS_IDENTITY_STALE` kararsızlığını düzelt. | — | daemon runtime-factory testi | opus |
| W1-3 | 50c: `node --import tsx` ile başlatılan daemon kuyruktaki işi başlatamıyor (`RUNTIME_START_FAILED`). | — | daemon runner, testkit `developmentRuntimeInvocation` | sonnet |
| W1-4 | CI: `workflow_dispatch` girdisi `win32_test_filter` ekle. Böylece win32 leg'i yalnızca hedef test dosyalarını 25 dakika sınırı içinde koşar. Windows birimlerinin kanıt yolu budur; `release-workflow.test.ts` kapsar. | — | `.github/workflows/ci.yml` | sonnet |

**W1'in ilk işi, W1-1'e ek:** macOS job'ları ara sıra 30 dakikalık sınıra kadar sessizce takılıyor.
- Görülen koşular: main `34897205539` darwin x64, PR #11 `34940697455` darwin arm64 ve x64.
- Aynı ağaç başka koşuda 5–10 dakikada geçiyor.
- x64'te iki koşu da tam aynı noktada sustu: `scripts/__tests__/render-homebrew-formula.test.ts` sonrası 16. dosya.
- Bun CI çıktısı dosya bitince yazıldığı için takılan dosya logdan okunamıyor.
- Birim şu adımları izler: dosya sırasını ve dosya başına süreyi görünür yap, takılan dosyayı bul, takılmayı düzelt. Bu düzelmeden W1'in diğer kanıtları güvenilir sayılmaz.

Controller aynı dalgada ayrıca şu todo işlerini yapar (subagent gerekmez):
- 35b: "Remote safety" başlığını işaretle;
- 4x: seçilmeyen alternatifleri üstü çizili yap;
- 18: native sonucu ve 9k (Linux arm64 yeşil koşusu) kanıtlarını CI koşu numaralarıyla ekle.

### W2 — Windows 1 (bağımsız kümeler)
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W2-1 | 9a: DaemonClient frame decoder takılmaları (300 sn beklemeler) | W1-2, W1-4 | cli/daemon client framing, protocol codec | opus |
| W2-2 | 9c: ManagedLogStore'da her çağrıda powershell.exe başlatan ACL kontrollerini toplu ya da kalıcı bir oturuma taşı | W1-4 | `platform/src/trust/*`, core log store | opus |
| W2-3 | 9f: Windows'ta SQLite/state yolu, disk ve gc hataları | W1-4 | core `state/*`, `resources/gc.ts` | opus |
| W2-4 | 52f: M4 (status yolu iki kez türetiliyor) ve M5 (uyarı hata metnine göre anahtarlanıyor) | — | cli doctor/status | sonnet |

Not: 9a–9h kümeleri `34873813789` loglarından doğrulanmadı. W2 başlamadan controller win32 logunu kümelere ayırır ve brief'lere düşen test listesini koyar.

### W3 — Windows 2
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W3-1 | 9b: named pipe IPC sunucu ve istemci | W2-1 | `platform/src/ipc/windows.ts`, daemon server | opus |
| W3-2 | 9d: supervisor ve anchor (CreationDate kimliği, `taskkill /T`) | W1-1, W2-2 | `platform/src/process/windows.ts`, `process-anchor.ts`, `process-supervisor.ts` | opus |
| W3-3 | 9h: Windows path canonicalization, sürücü harfi/UNC, NTFS junction ve reparse point güvenliği | W2-3 | `platform/src/paths`, core git analysis/removal | opus |
| W3-4 | 51f: M2 (`ENOTDIR`/`ELOOP` kodsuz) ve M3 (Windows ACL okuma hatası kalıcı sayılıyor) | W2-2, W2-3 | core private-dir hataları, `platform/src/trust`, docs/18 | sonnet |

W3-3 ile W3-4 birbirine yakın dosyalara dokunur. İkisi aynı anda koşar ama W3-4, W3-3 birleştikten sonra birleşir.

### W4 — Windows 3
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W4-1 | 9e: heavy-job süreç ağacı temizliği; 50d native kanıtı | W3-2 | daemon `heavy-job-queue.ts` | opus |
| W4-2 | 9g: CLI yüzeyi testleri (`/bin/sh` bağımlılığı, `getuid` boşluğu) | W3-1 | `packages/cli/src/__tests__/*`, cli komutları | sonnet |
| W4-3 | 9i: Scheduled Task yaşam döngüsü, PowerShell install/uninstall ve completion, Git Bash testi | W3-1 | `platform/src/service/windows.ts`, cli completion, README, SKILL.md | opus |
| W4-4 | 35d: farklı `HOME`'larda aynı anda iki daemon senaryosu | — | yeni daemon/cli senaryo testi | sonnet |

### W5 — Windows kapanışı ve release başlangıcı
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W5-1 | 9j: win32 leg'ini yeniden zorunlu yap (`continue-on-error` ve 25 dk sınırını kaldır), docs/12'yi güncelle, "Windows x64 CI green" satırını kanıtla işaretle | W2-1…W4-3 | `.github/workflows/ci.yml`, docs/12 | sonnet |
| W5-2 | 29a: release'te Linux x64 ve arm64 arşivlerini yayınla | W1 (9k kanıtı) | `release.yml`, `scripts/artifact-targets.ts`, `verify-release.ts` | opus |
| W5-3 | 9m: aynı `wtm.toml` fixture'ı üç OS'ta; JSON kontrat eşitliği (K2 kararına göre) | K2, W2-3 | core config fixture'ları, docs/18, daemon status JSON | opus |
| W5-4 | 35a: lifecycle parity testleri (cleanup candidates, performance gate, resource lifecycle, events). Önce PR #11 sonrası açık satırlar doğrulanır. | — | `scripts/__tests__`, core/daemon testleri, docs/08, docs/14 | sonnet |

W5 sonunda controller şu satırları CI kanıtıyla işaretler: 35c (Platform) ve R1 (release checklist'teki CI, E2E, binary ve paket satırları).

### W6 — Release 2 ve ilk özellikler
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W6-1 | 29b: release'e Windows x64 zip hedefi ve smoke testi | W5-1, W5-2 | `release.yml`, `artifact-targets.ts`, `build-sea.ts` | opus |
| W6-2 | 49a: DB task kayıtları (migration **016**), öncelik, placeholder'lar, `explain` kaynağı | K3 | migrations, `assets.ts`, `sea-assets.ts`, daemon `task-resolution.ts`, cli `explain.ts`, docs/03 | opus |
| W6-3 | 13: `wtm status`'ta PR farkındalığı, sağlayıcı arayüzü arkasında (gerekirse migration **017**) | K4 | cli `status.ts`, daemon CI watcher, protocol, docs/04, docs/18, SKILL.md | opus |
| W6-4 | 31: platform bazında CI görünürlüğü, `SUPPORT.md`'de minimum OS sürümleri | W5-1 | README, SUPPORT.md | sonnet |

W6-2 ile W6-3 aynı slotta birleşmez; migration dosyaları sırayla birleşir.

### W7 — Release 3 ve task kayıtları
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W7-1 | 29c: tüm artifact'lar için SHA256SUMS ve provenance; gate her zorunlu platformu görmeden yayın yapmaz | W5-2, W6-1 | `release.yml`, `verify-release.ts`, docs/12 | opus |
| W7-2 | 49b: `wtm task list/show/set/unset` + trust kaydı | W6-2 | cli, protocol, docs/04, docs/18, docs/06, docs/11, SKILL.md | opus |
| W7-3 | 49c: `wtm remove` task kayıtlarını temizler; K3 evetse `wtm task export` | W6-2 | core `remove-worktree.ts`, cli | sonnet |
| W7-4 | R3: JSON kontrat uyumu ve migration/upgrade testleri, 001→son migration zinciri | W6-2, W6-3 | `packages/core/src/state/__tests__` | sonnet |

38b (npm OIDC), kullanıcı npm tarafını kurunca `release.yml`'e dokunan tek birim olarak W7-1'den sonra kuyruğa girer.

### W8 — Worktree bağlamı ve dağıtım
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W8-1 | 48: kök Makefile hedefleri worktree bağlamında | K5, W7-2 | `adapters/src/make.ts`, task resolution, `explain.ts`, docs/03, docs/04, docs/06, SKILL.md | opus |
| W8-2 | 24: `install.sh` ve `install.ps1` (checksum, mimari algılama, upgrade) | W6-1, W7-1 | yeni scriptler, README, `cli-docs.test.ts` | sonnet |
| W8-3 | 14: idle runtime suspension, varsayılan kapalı (gerekirse migration **018**) | K6 | daemon supervisor, config şeması, docs/03, docs/07 | opus |
| W8-4 | 50b: süreç ağacı bellek örneklemesinin maliyet sınırı; kabul ile hard limit ayrımının dokümanı | K7 | daemon `heavy-job-queue.ts`, docs/07, SKILL.md | sonnet |

Çakışma notu: W8-3 supervisor'a dokunur. O sırada supervisor'a dokunan başka birim yok; W4-1 bitmiş olmalı.

### W9 — Platform genişletme
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W9-1 | 19: kaynak bütçeleri, 50 ile ortak muhasebe (gerekirse migration **019**) | K7, W8-4 | config, daemon, docs/03 | opus |
| W9-2 | 20: workspace presets/templates | K9 | core init, `examples/`, docs/09, docs/04 | sonnet |
| W9-3 | 21a: adapter kontrat versiyonlama | K9 | protocol, adapters, docs/06 | opus |
| W9-4 | 12b: proxy backend ve hostname tahsisi (12a spec'i K8 ile onaylanmış olmalı) | K8 | daemon, protocol, core endpoints, docs/04, docs/07 | opus |

### W10 — Ekosistem
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W10-1 | 12c: CORS entegrasyonu ve yerel sertifikalar | W9-4 | core env/endpoints, docs/03 | opus |
| W10-2 | 21b: adapter SDK paketi, yazım rehberi, test harness | W9-3 | yeni paket, docs/06 | opus |
| W10-3 | 21c: trust UX iyileştirmesi | W7-2 | core trust, cli | sonnet |
| W10-4 | 46a: dev overlay enjeksiyon katmanı ve prod'a sızmama testi | K10, W7-2 | adapters/proxy, protocol, docs/03 | opus |

### W11 — Kapanış
| Birim | İş | Bağ. | Kod alanı | Model |
|---|---|---|---|---|
| W11-1 | 46b: overlay veri ucu, ajan kontrol listesi, kardeş repo endpoint'leri | W10-4 | protocol, docs/04, docs/11, SKILL.md | opus |
| W11-2 | 5b: quarantine workaround'unu kaldır, testini sil | 5a (gerçek `spctl` yeşil) | README, CHANGELOG, `gatekeeper-workaround.test.ts` | sonnet |
| W11-3 | 23: npm version badge | 38a | README | sonnet |
| W11-4 | R4 + R5: README ve Skill ile CLI parity doğrulaması, CHANGELOG hazırlığı. **Tüm doküman değiştiren PR'lardan sonra en son birleşir.** | W11-1…W11-3 | CHANGELOG, gerekirse README/SKILL.md | sonnet |

Kapanışta controller şu satırları işaretler, hepsi kanıt gerektirir:
- 28: package metadata başlığı;
- 36: Gatekeeper;
- R0: bütün P0 maddeleri bitti;
- R2: imza ve notarization;
- R6: temiz makinede doğrulama.

Ertelenen maddeler: 15 (TUI/menu bar, K11), 21d (community registry), 30c (deb/rpm/Chocolatey). Bunlar yalnızca talep olursa yeni dalgaya girer.

## 4. Her brief'e girecek global kısıtlar
- Katmanlar protocol ← platform ← core ← daemon/cli şeklindedir. Core `spawn`, `execFile`, `process.platform` ve `@wtm/platform` kullanmaz.
- `exactOptionalPropertyTypes` açıktır. Testler `__tests__` altındadır. Relative import'larda uzantı yoktur.
- Test içindeki child process'ler yalnızca `runScenario` ile başlatılır.
- better-sqlite3, Bun içinde in-process çalıştırılmaz. Store testleri node altında `*.scenario.ts` olarak koşar, parent test çıkan JSON'u doğrular.
- Testler gerçek `gh` çalıştırmaz ve ağa çıkmaz. Gerçek `~/Library` WTM durumuna dokunulmaz. Çıplak `git stash` kullanılmaz.
- Envelope: `{schemaVersion:1, ok, command, data, warnings, errors[{code,message,severity,context?,remediation?}]}`. Yeni hata kodları docs/18'e yazılır.
- Yeni migration eklendiğinde üç dosya birlikte değişir: migrations dizini, `packages/core/src/state/assets.ts` ve `packages/cli/src/sea-assets.ts`.
- Commit mesajları `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` ile biter.
- Implementer subagent başlatmaz, push etmez, PR açmaz.

## 5. Onay ve durma kuralları
- **Merge:** kullanıcı her dalganın başında o dalga için "CI yeşil olunca birleştir" onayı verir. Onay yoksa birim PR'da bekler ve slot bir sonraki birimle devam eder.
- **Durma:** controller yalnızca şu durumlarda durup sorar:
  - geri alınamaz ya da güvenlik açısından hassas bir işlem;
  - kullanıcı kapısı (§2.1);
  - cevaplanmamış tasarım kararı (§2.2);
  - planın bir birimi uygulanamaz çıkarsa.
- Diğer belirsizlikler ledger'a "Karar: … — neden — yanlışsa bedeli" biçiminde yazılır ve iş devam eder.
- **İzleme:** CI beklemeleri arka planda sınırlı döngülerle yapılır. Kısa aralıklarla yoklama yapılmaz.
- **Rapor:** her birleşmeden sonra tek satır durum verilir; her dalga sonunda todo yüzdesi (alt maddeler, ana maddeler, v0.2.0 checklist) raporlanır.
