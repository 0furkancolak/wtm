# 2026-09-21 — Yayına hazırlık denetimi

Koordinatörün talimatıyla (2026-09-21T22:56Z), v0.2.0 dalga planının son işlerinden biri olarak
yapılan bütünsel bir tutarlılık denetimi. Kapsam: `docs/01`–`docs/19` ile gerçek kod arasındaki
tutarsızlıklar (özellikle bu dalgada eklenen `[budgets]`, `[dev-overlay]`, proxy, `wtm task`,
`wtm adapter untrust`, `workspace-here:`), `wtm --help`'in gerçek komut listesi ile
`docs/04-cli-reference.md` arasındaki eşleşme, CHANGELOG'un `[Unreleased]` bölümünün #62–#67'yi
kapsayıp kapsamadığı, ve kanıt borcu defterinin (`2026-09-21-ci-outage-evidence-debt.md`) #62–#67
dahil eksiksiz olup olmadığı.

Denetim bir alt ajana devredildi (kod okuma + grep ile doğrulama, hiçbir dosya değiştirilmeden);
bulunan küçük tutarsızlıklar bu thread tarafından tek PR'da düzeltildi. Bu belge o denetimin
kaydıdır.

## Sonuç özeti

Belgeler bu dalganın büyük çoğunluğu için **beklenenden iyi durumda**: `[budgets]`,
`[dev-overlay]`, `wtm task *`, `wtm adapter untrust`, `workspace-here:<target>` — beşi de kod ile
docs/03, docs/04, docs/06, docs/07, docs/11 arasında satır satır doğrulandı ve tutarsızlık
bulunmadı. Gerçek boşluklar iki yerde yoğunlaştı: docs/07'de tek bir bayatlamış cümle (düzeltildi)
ve docs/04'te eksik bir komut bölümü (düzeltildi); iki üst-düzey belge (`docs/02`,
`docs/13`) ise bu dalgada eklenen alt sistemlerin bir kısmını hiç yansıtmıyor — bunlar tek bir
küçük düzeltmeyle kapatılamayacak kadar geniş, aşağıda madde madde bırakıldı.

## Küçük tutarsızlıklar — düzeltildi (tek PR)

### 1. `docs/07-process-port-runtime.md` — bayatlamış "CORS entegre değil" iddiası

Eski metin (satır ~123-125), CORS origin auto-entegrasyonunu "ayrı, sonraki bir parça, bu birimin
kapsamında değil" diye anıyordu. Bu W10-1 (#60) ile yanlışlandı: `task-resolution.ts` `[proxy]`
etkinken proxy hostname'ini CORS allowlist'ine otomatik ekliyor, `docs/03`'ün CORS bölümü bunu
zaten doğru anlatıyor, todo.md bunu 2026-09-21'de işaretli gösteriyor. Metin, HTTPS/sertifika ve
port-tahsisi geriye-uyumluluğu hâlâ kapsam dışıyken CORS'un artık yapıldığını söyleyecek şekilde
düzeltildi, docs/03'e çapraz referans eklendi.

### 2. `docs/04-cli-reference.md` — `wtm completion <shell>` hiç belgelenmemişti

`packages/cli/src/main.ts` gerçek, gizli-olmayan bir `completion <shell>` komutu kaydediyor
(bash/zsh/fish betiği basıyor, `program.commands`'tan dinamik okuyor). docs/04'te sıfır referans
vardı. Yeni bir "## Shell completion" bölümü eklendi.

Her iki düzeltme de bu denetimin PR'ında; ayrıca aynı PR'a CHANGELOG'un `[Unreleased]` bölümüne
#65 (dev overlay) ve #66 (`workspace-here:`) için eksik girişler bindirildi (aşağıya bakın).

## Büyük bulgular — açık kalan, tasarım kararı gerektiriyor

### 3. `docs/02-architecture.md`'nin "Daemon responsibilities" listesi üç alt sistemi hiç anmıyor

Liste (satır ~81-92) yalnızca: dosya sistemi izleme, reconciliation zamanlama, platform IPC
sunucusu, kalıcı managed-process supervision, log yönlendirme/rotasyon, servis kurulum durumu,
arka plan cleanup denemeleri. Hiç anılmayan üçü: yerel reverse proxy (`packages/daemon/src/proxy.ts`,
`proxy-routes.ts`, `proxy-policy.ts`), dev overlay (`packages/daemon/src/dev-overlay.ts`),
işlem/bellek bütçesi admission kapısı (`packages/daemon/src/runtime-controller.ts`). Üçü de
daemon-geneli, opt-in, config-güdümlü alt sistemler — listede zaten olan "arka plan cleanup
denemeleri" ile aynı sınıftan. Bu, yeni bir okuyucunun/ajanın önce başvuracağı üst-düzey mimari
belgesi olduğu için release-hazırlığı açısından gerçek bir boşluk.

**Öneri:** listeye üç madde eklenecek şekilde küçük bir takip PR'ı; tasarım kararı gerektirmiyor,
yalnızca zaman ayırmak gerekiyor — bu yüzden (a) kovasına yakın ama bu denetimin kapsamı dışında
bırakıldı.

### 4. `docs/13-data-model-and-state-machines.md` PR #50-#66 arasında eklenen çoğu tabloyu içermiyor

Belgelenen tablolar: `workspaces`, `repositories`, `worktrees`, `endpoint_leases`,
`managed_processes`, `repository_operation_leases`, `resources`, `adapter_trust`, `cleanup_jobs`.

Gerçekte var olan ama belgelenmeyen tablolar (migration dosyalarından grep):
`managed_process_start_reservations`, `resource_sandboxes`, `resource_storage_objects`,
`resource_references`, `resource_cleanup_leases`, `resource_gc_journal(_next/_hardened)`,
`lifecycle_event_dispatches`, `heavy_jobs`, `heavy_job_state_owner`, `features`,
`feature_creations`, `feature_creation_members`, `ci_watches`, `ci_runs`, ve — bu denetimin
kapsamına en doğrudan giren — **`task_overrides`** (migration 016, `wtm task
list/show/set/unset/export`'un arkasındaki tablo).

Bu, tek bir maddeden ("`task_overrides` eksik") çok daha geniş bir bayatlamayı işaret ediyor:
belgenin çoğu PR #50-#66'dan (heavy job kuyruğu, CI watch, çok-repo feature oluşturma, task
override'ları) önceki bir hâli yansıtıyor.

**Öneri:** iki seçenek var — (i) `task_overrides`'ı (ve ideal olarak kullanıcıya `wtm
jobs`/`wtm ci`/`wtm create --repos` üzerinden zaten görünen `heavy_jobs`/`ci_watches`/`features`'ı)
tek bir küçük ekleme PR'ıyla kapatmak, ya da (ii) belgenin tamamını PR #50-#66 sonrası duruma göre
yeniden yazmak. İkincisi bir tasarım/kapsam kararı istiyor (hangi iç tabloların — `resource_gc_*`,
`repository_operation_leases` türü uygulama detaylarının — bu belgenin okuyucu kitlesine (kullanıcı
mı, katkıda bulunan ajan mı) göre belgelenmeye değer olduğu), bu yüzden bu denetimin kapsamında
yapılmadı; Kaptan'ın veya koordinatörün kapsam kararı vermesi gerekiyor.

## Doğrulanan, bozuk olmadığı teyit edilen alanlar (negatif sonuçlar)

- **Hata kodu sözleşmesi**: `packages/protocol/src/errors.ts`'in `wtmErrorCodeSchema`'sı (60 kod)
  ile `docs/18-errors-json-contract.md`'nin "Stable V1 error families" bölümü birebir eşleşiyor —
  her iki yönde de programatik olarak doğrulandı, `errors.test.ts` 5/5 yeşil. Yeni
  `RUNTIME_PROCESS_BUDGET_EXCEEDED`/`RUNTIME_MEMORY_BUDGET_EXCEEDED` kodları docs/03, docs/07 ve
  docs/18'de doğru `context` alan adlarıyla mevcut.
- **`[budgets]` şeması vs docs**: alan adları, sınırlar (1-10000 / 1-1.048.576 MiB), "zaten
  çalışan bir task'ı yeniden başlatmak bütçeye sayılmaz" davranışı — hepsi kod ile docs/03/docs/04
  arasında birebir.
- **`[dev-overlay]` şeması vs docs**: tek alan (`enabled`), content-type/content-encoding kapıları,
  sibling-endpoint çözümü — docs/03 ve docs/07 ile birebir.
- **Proxy hostname formatı**: slugify kuralı, sha256-ilk-6-hex-karakter çakışma soneki,
  en-düşük-numericId-plain-slug-alır kuralı — docs/07 ile mekanik olarak birebir.
- **`wtm task *`**: docs/04 (bir `### wtm task ...` başlığı yerine "## Task overrides" düz-yazı
  bölümü altında — grep bunu ilk taramada kaçırdı, ikinci geçişte bulundu), docs/03, docs/06,
  docs/11 ile tam tutarlı; bayraklar (`--run`, `--argv`, `--cwd`, `--shell`, `--background`,
  `--singleton`, `--description`, `--env`, `--task-json`) kodla birebir.
- **`wtm adapter untrust`**: docs/04 ve docs/06 ile, `{ removed: boolean }` dönüş şekli dahil,
  birebir.
- **`workspace-here:<target>`**: docs/03, docs/04, docs/06 ile, enjekte edilen iki değişken ve
  `-f <path>` mekanizması dahil, birebir (bu thread'in kendi PR #66'sı — beklenen sonuç).
- **`wtm --help` (gerçek komut envanteri) vs docs/04**: `main.ts`'teki her `program.command(...)`
  tek tek çıkarıldı (status/doctor/explain/plan/env/ports, resolve, run, ci watch/status/unwatch,
  task list/show/set/unset/export, analyze, create, remove, start/stop/restart, ps, logs, exec,
  daemon install/uninstall/status/serve, disk, gc, forget, adapter list/trust/untrust, init,
  detect, skill print/install, completion, gizli `__complete` veri komutu). `completion` hariç
  (madde 2, düzeltildi) hepsinin docs/04'te bir karşılığı var — docs/04 komut ailelerini tematik
  "## " bölümleri altında grupluyor (`## CI`, `## Task overrides`, `## Daemon` gibi), tek tek
  `### wtm x` başlığı olarak değil; ileride bu dosyaya karşı bir başlık-tabanlı lint script'i
  yazılırsa bu gruplama gerçek komutları false-negative olarak işaretleyebilir — not olarak
  düşülüyor.
- **CHANGELOG `[Unreleased]`**: #62/#63/#64/#67 dokümantasyon-only oldukları için giriş almıyor
  (mevcut politika ile tutarlı — #43/#44/#47-49/#53 emsali). #65 (dev overlay) ve #66
  (`workspace-here:`) gerçek kullanıcı-görünür özellik olduğu için eksikti, bu denetimde eklendi
  (ayrı bir commit, aynı PR).
- **Kanıt borcu defteri** (`2026-09-21-ci-outage-evidence-debt.md`): #62-#67 aralığında hiçbir
  eksik satır yok — #65 ve #66 (gerçek kod) zaten kendi satırlarını taşıyordu, #62/#63/#64/#67
  (dokümantasyon-only) doğru şekilde satırsız.

## Release-hazırlığı açısından anlamı

Bu denetimin bulduğu hiçbir şey bir yayını engellemiyor: küçük olanlar düzeltildi, büyük olanlar
(docs/02, docs/13) kullanıcı-görünür bir hataya değil, iç/katkıda-bulunan-belgesi bayatlamasına
işaret ediyor. Kaptan'ın elindeki iki gerçek kapı (madde 5a — Apple notarization sırları + gerçek
tag push; madde 38a — npm 2FA + ilk `@next` publish) ve Actions kotasının dönmesi hâlâ tek gerçek
blokaj. Bu thread bu denetimden sonra yeni bir birim almıyor; koordinatörün kendi ifadesiyle geri
kalan her şey bu iki kapıya ve kotaya bağlı.
