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

**2026-09-22 ikinci takip: kapsam ölçüldü, "bağlantıyı kur" değil "üretici motoru inşa et".**
Koordinatörün talebiyle bir Explore ajanı üretim çağrı zincirini haritaladı. Sonuç, yukarıdaki
notu düzeltiyor ve genişletiyor: bu tek bir eksik satır değil. `materializer.ts`/`guard.ts`
(`planResourceMaterialization`, `applyMaterializationPlan`, `createResourceGuard`) — bu beş
tabloyu üretecek motorun kendisi — hiçbir üretim çağrı yeri olmadan duruyor, yalnızca testlerden
çağrılıyor. Bugünkü gerçek üretim kaynak yolu (`packages/core/src/resources/preparation.ts`,
`wtm run`/`wtm resolve --prepare` tarafından tetiklenir) tamamen ayrı, saf dosya sistemi seviyeli
bir boru hattı; docs/08'e göre `[resources]` ile bildirilen worktree-yerel dosyalar *kasıtlı
olarak* her sandbox'ın dışında tutuluyor ve asla buraya satır yazmamalı. Ayrıca eski `resources`
tablosu (migration 001) tamamen ölü kod — `sqlite-store.ts` içinde ne okuyan ne yazan tek bir
store metodu var; kimse bunu bir "üstteki tablo" gibi kullanmıyor.

Açık, hiçbir yerde belgelide cevabı olmayan tasarım soruları: hangi adapter kaynak tipleri hangi
sandbox'a, ne zamanlanmış materyalize olur; `resource_sandboxes.generation` ne zaman artar;
adapter retention politikasından ephemeral/persistent sınıflandırmasına eşleme;
`resource_references` edinme/bırakma sahipliği; aynı sandbox'ı paylaşan worktree'ler arası eşzamanlı
materyalizasyon yarışları (GC tarafında lease var, yazma tarafında yok). `todo.md`'nin kendi notu
(~L2681-2688) da aynı sonucu daha önce çıkarmıştı: "yazma yolunu bağlamak ayrı, çok daha büyük bir
birim." Bu doğrulandı — küçük bir PR'a bölünebilecek bir "eksik kablo" değil, kendi tasarım kararı
(muhtemelen bir sonraki "K" numarası) gerektiren, v0.2.0 dalga planının dışında yeni bir özellik.
Bu yüzden burada tek taraflı olarak inşa edilmedi; bulgu docs/13 + bu belgeye işlendi ve koordinatöre
bildirildi.

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

## 2026-09-22 üçüncü takip: K12 — GC sandbox yazma yolu v0.2.0 dışında kalıyor

Koordinatör, Kaptan'ın onayıyla ("Kalan işlerin tamamına devam et ve çözüm üret", 2026-09-22T15:54Z)
GC sandbox/storage-object yazma yolunun tasarlanıp inşa edilmesini istedi; üç birim önerdi:
`preparation.ts`'in üretim yolunu `materializer.ts`/`guard.ts` motoruna bağlamak, ölü `resources`
tablosunun (migration 001) temizliği, ve TUI panelinin (#73) gerçek veri göstermesi. Tasarım
kararını yazmadan önce kod tabanı ve mevcut belgeler derinlemesine incelendi; sonuç, önerilen
birim 1 ve 3'ü geçersiz kılan iki bulgu çıkardı.

**Karar (K12): sandbox/storage-object yazma yolu v0.2.0 kapsamına alınmıyor; bu, hâlâ bulunması
gereken bir "eksik kablo" değil, docs/07 ve docs/08'in kendi imzasıyla zaten V1 dışına
konumlandırdığı bir özellik.**

- **Neden — bulgu 1 (birim 1'i geçersiz kılıyor): `preparation.ts`'i sandbox'a bağlamak, kodun
  kendi belgelediği bir güvenlik değişmezini ihlal eder.** `preparation.ts`'in kendi doc-comment'i:
  "The general resource guard cannot do this. It is built for a sandbox that WTM may sweep, and
  refuses a Git working tree as one — correctly, because `gc` must never walk a repository."
  docs/08 aynı kuralı tekrarlıyor: "The files `[resources]` creates inside a worktree are outside
  every sandbox, deliberately... They therefore carry no lifecycle record, and `gc` will not
  collect them at any point." `guard.ts`'nin `createResourceGuard`'ı `workspaceRoot`'u ve her
  `repositoryRoots` girdisini `sandboxRoot` olarak açıkça reddediyor (`deny('The configured
  resource sandbox is too broad.')`). Bu üç kanıt (docstring + doc + test edilen kod) aynı
  yöne işaret ediyor: worktree-yerel `[resources]` hiçbir zaman sandbox'a bağlanmamalı. **Yanılırsak
  maliyeti:** bu değişmezi ihlal eden bir "bağlantı" `gc`'nin bir Git çalışma ağacını taraması
  anlamına gelir — repository dosyalarını silme riski taşıyan, testlerle açıkça engellenmiş bir
  sınıf hata.
- **Neden — bulgu 2 (birim 1 ve dolayısıyla birim 3'ü geçersiz kılıyor): sandbox'ın gerçekte neyi
  barındıracağı hiçbir yerde belirtilmemiş, ve en olası aday (adapter'ların paylaşımlı bağımlılık
  önbelleği) projenin kendi mimari ilkesiyle çelişiyor.** `resource-production.ts`'in yorumu
  sandbox kökünün `.resources` (workspace altında) olduğunu söylüyor — ama bunun ne
  materyalize edeceğine dair TEK somut ipucu bu. docs/README.md madde 6: "Native cache first. WTM
  uses package-manager/compiler caches instead of inventing another dependency cache." docs/08,
  "GC scope": "Adapter-declared disposable build outputs and adapter-native dependency cleanup
  plans are not part of this [V1] mode." docs/07, aynı "adapter-declared, adapter-native
  resources" kategorisi için (Docker container/network/volume örneğiyle) birebir aynı cümle
  kalıbı: "This table records the intended shape once an adapter declares such resources, not
  current behavior; `todo.md` has no item tracking the adapter-side work yet." Bugün hiçbir
  adapter böyle bir kaynak bildirmiyor, `adapter-sdk`'da bunun için bir bildirim yüzeyi yok, hiçbir
  ADR bu şemayı tarif etmiyor. `generation` ne zaman artar, hangi adapter tipi hangi retention'a
  eşlenir, `resource_references` sahipliği kime ait — bunların hiçbirinin yazılı cevabı yok.
  **Yanılırsak maliyeti:** bu semantiği burada icat etmek, "native cache first" ilkesiyle çelişen
  ve muhtemelen atılacak bir V2 özelliğini şimdiden, yanlış varsayımlarla inşa etmek demek —
  docs/07'nin Docker kaynaklarına yaptığı gibi, bunu açıkça V1-dışı bırakmak daha ucuz ve daha
  doğru.

**Ne yapıldı, ne yapılmadı:**
- `preparation.ts` → `materializer.ts`/`guard.ts` bağlantısı **kurulmadı** (kasıtlı olarak, yukarıdaki
  gerekçeyle) — bir daha yanlışlıkla denenmesin diye bu belgeye ve docs/08 + docs/13'e not düşüldü.
  TUI paneli (#73) zaten dürüst boş-durum notu veriyor; gösterecek gerçek veri yok, o yüzden birim 3
  de değişmedi.
  - Ölü `resources` tablosu (migration 001) **kaldırıldı** — bu, K12'den bağımsız, kendi başına
  güvenli bir temizlik; ayrı bir PR'da.
- Karar `docs/superpowers/plans/2026-09-15-remaining-work-waves.md`'in 2.2 tasarım kararları
  tablosuna K12 olarak eklendi (K11 zaten madde 15/TUI için kullanılmıştı, o karar TUI'nin
  inşa edilmesiyle kendiliğinden çözüldü).
