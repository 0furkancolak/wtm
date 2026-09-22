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

## Büyük bulgular — koordinatör kapsam kararını verdi, kapatıldı

Koordinatör (2026-09-21T23:08Z) ikisinin de Kaptan'a gitmesine gerek olmadığını, kapsam kararını
kendisinin verdiğini bildirdi ve artımlı bir tamamlama talimatı verdi — tam yeniden yazım değil.
Aşağıdaki iki madde bu talimatla, aynı takip PR'ında kapatıldı.

### 3. `docs/02-architecture.md`'nin "Daemon responsibilities" listesi üç alt sistemi hiç anmıyordu — düzeltildi

Listeye (satır ~81-96) yerel reverse proxy, dev overlay ve işlem/bellek bütçesi admission kapısı
için iki madde eklendi, `docs/07`'nin ilgili bölümlerine çapraz referansla.

### 4. `docs/13-data-model-and-state-machines.md` PR #50-#66 arasında eklenen çoğu tabloyu içermiyordu — artımlı olarak tamamlandı

Koordinatörün talimatı: "`task_overrides` başta olmak üzere" #50-#66 arasında eklenen, kullanıcıya
CLI üzerinden zaten görünen tabloları mevcut belgenin şemasına uyacak şekilde ekle; durum
makinelerini de bu dalgada değişenler kadarıyla güncelle; belgenin tamamını yeniden yazmak
v0.2.0'ın işi değil.

Eklenenler (`## Core tables` altına, mevcut terse şema-bloğu üslubunda): `task_overrides`,
`heavy_jobs` (+ tek satırlık `heavy_job_state_owner` notu), `ci_watches`/`ci_runs`,
`features`/`feature_creations`/`feature_creation_members`. Yeni durum makineleri: `## Heavy job
state`, `## CI watch state`, `## Feature creation state`.

**2026-09-22 takip: yedi tablodan beşi belgelendi, ikisi kasıtlı olarak dışarıda kaldı.**
Koordinatörün bıraktığı tasarım kararı ("hangi iç tablonun bu belgenin okuyucu kitlesine göre
belgelenmeye değer olduğu") şöyle verildi: `resource_sandboxes`, `resource_storage_objects`,
`resource_references`, `resource_cleanup_leases`, `resource_gc_journal` docs/13'e eklendi (yeni
`### `-bölümleri artı yeni bir `## Resource GC state` durum makinesi bölümü), çünkü bunlar zaten
belgelenmiş `resources`'ın alt tablosu değil — kendi başlarına ayrı bir durum makinesine sahip
(`READY/STALE/ORPHANED/QUARANTINED/REMOVED` artı yedi fazlı journal), zaten belgelenmiş iki komutu
(`wtm gc`, `wtm disk`, docs/08 + docs/04) besliyorlar ve docs/'un hiçbir yerinde (docs/08 dahil) bu
quarantine/journal mekanizması hiç anlatılmıyordu — bu gerçek bir boşluktu, saf tekrar değil.
Kontrol ederken önemli bir bulgu çıktı ve docs/13'e not olarak eklendi: bu beş tablonun *yazma*
tarafı (`registerResourceSandbox`/`registerResourceStorageObject`) bugün yalnızca testlerden
çağrılıyor — `packages/core`, `packages/daemon`, `packages/cli` içinde hiçbir üretim kod yolu bu
satırları doldurmuyor. Yani canlı bir daemon'da sandbox tablosu her zaman boş ve `wtm gc`'nin
sandbox tabanlı aday listesi de öyle; plan/apply/recovery makinesi (`buildGcPlan`/`applyGcPlan`/
`recoverGcJournalEntry`) gerçek ve kendi testleriyle doğrulanmış, sadece kayıt (write) yolu
bağlanmamış. Bu, docs/13'ün görevi değil (belgeleme, uygulama değil) ama belgeye dürüstçe not
düşüldü ki okuyan biri bunu canlı sanmasın; ayrı bir birim (kaydı üretim koduna bağlamak) olarak
kalıyor, burada iddia edilmiyor.

`managed_process_start_reservations` ve `lifecycle_event_dispatches` bilerek dışarıda bırakıldı:
ikisi de kendi durum makinesi olmayan, tek amaçlı defter tabloları — biri `managed_processes`'in
zaten belgelenmiş STARTING durumunun altındaki token+TTL dedup mekanizması (ki
`repository_operation_leases`'in aksine, `managed_processes`'in kendi durumundan ayrı okunacak
yeni bir bilgi taşımıyor), diğeri "bu olay bir daha gönderilmesin" defteri (subject/event ->
dispatched_at, tek satırlık bir fact table, hiçbir kullanıcıya görünen komutun sözleşmesine
bağlı değil). Belgelemeye eklemek yalnızca "bu ikisini önleyen bir token/defter var" cümlesini
tekrar ederdi, yeni bir okur değeri katmazdı.

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
