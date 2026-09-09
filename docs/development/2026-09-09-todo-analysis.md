# WTM: TODO analizi ve ilk geliştirme dilimi

Tarih: 2026-09-09. İncelenen başlangıç commit'i: `2fbdd02b5abec90a79dc661dc9f069726cea9831`.
Sürüm hedefi: `v0.2.0`; mevcut paket sürümü `0.1.0-rc.1`.

## Sonuç

WTM'nin temel güvenlik ve runtime yapısı mevcut. Yeni bir mimari kurmak yerine, açık maddeleri
mevcut kod ve testlerle eşleştirerek küçük dilimler hâlinde ilerlemek uygun. `todo.md` başlıklarının
açık olması, altındaki işin hiç yapılmadığı anlamına gelmiyor; bazıları tek bir eksik kabul
kriteri nedeniyle açık. Dokümandaki eski tasarım dosyaları da uygulama tamamlandığı hâlde
"planned, not started" diyebiliyor. Güncel durum için kod, test ve ana TODO birlikte okunmalı.

## Mimari ve mevcut durum

| Alan | Kodda bulunan yapı | Sonraki iş açısından anlamı |
| --- | --- | --- |
| Protocol | Zod hata/IPC/JSON sözleşmeleri | Yeni hata kodu yalnızca core'a eklenemez; protocol, CLI exit kodu ve doküman birlikte değişmeli. |
| Core | Config, Git analizi, SQLite state, resource cleanup, operation lease | Güvenlik ve sahiplik kuralları bu katmanda kalmalı. |
| Platform | Process, IPC, path, trust ve service arayüzleri | Linux/macOS/Windows doğrulaması salt fixture testleriyle tamamlanmış sayılmamalı. |
| Daemon | Reconcile, task çözümleme, process supervision, lifecycle events | Readiness ve çok depolu create, mevcut daemon davranışına bağlanmalı. |
| CLI | Commander girişleri, yerel/daemon composition, JSON/human çıktı | `main.ts` büyük; yeni iş mantığı buraya yığılmamalı. Bu dilimde geniş bir refactor yapılmadı. |
| Testkit | Geçici Git depoları, yerel bare remote, izole Node senaryoları | Silme testlerinde gerçek Git ve geçici dosyalar kullanılabiliyor. |

## Önceliklerin kodla karşılaştırılması

| TODO | Doğrulanan durum | Kalan bağımlılık / yapılacak iş |
| --- | --- | --- |
| 1, 2: removal ve locking | Runtime cleanup zinciri, SQLite lease ve repository genelinde cross-operation conflict mevcut. | Gelecekteki `repair` komutu henüz yok; bunun için mevcut kilidi baştan yazmak gerekmiyor. Native process/lease testleri ayrıca geçmeli. |
| 3, 8: remote safety | Explicit fetch ve allowed remote refs config mevcut. | Yerel ref bilgisi ile fetched bilgi ayrımı korunmalı. |
| 4: performance gate | Release workflow ve verifier içinde gerçek gate mevcut. | Gate kodunun varlığı, gerçek platform ölçümlerinin başarılı olduğu anlamına gelmez. |
| 5, 36: macOS dağıtımı | Notarization submission ve publish gate kodu mevcut. | Apple credential kurulumu ve quarantine taşıyan artifact'ın temiz macOS üzerinde denenmesi gerekiyor. |
| 38: npm yayın kanalı | Publish akışı tanımlı. | Gerçek registry publish, dist-tag, provenance ve temiz kurulum kabul kriterleri açık. Bu dilimde yayın yapılmadı. |
| 6: create | Tek depoda yeni/var olan branch, `--from`, çakışma kontrolleri, local reconcile mevcut. CLI create testleri başarılı. | Çok depolu feature identity, kalıcı creation journal, lock sırası ve partial failure recovery tasarlanmalı. |
| 7: cleanup ranking | Güvenlik, çalışan process, persistence, aktivite, commit yaşı ve prunable bilgisi sıralamaya giriyor. | Reclaimable disk ölçümü yok; recursive tarama bütçesi ve hardlink/symlink/shared storage semantiği belirlenmeden sayı eklenmemeli. |
| 9: platformlar | Üç platform için katmanlar ve CI matrix girdileri var. | TODO'nun Windows native doğrulama ve Linux ARM64 açık kriterleri korunmalı; matrix satırı tek başına destek kanıtı değil. |
| 10: readiness | `start` ve supervisor mevcut; task healthcheck config'i ve readiness sonucu henüz yok. | Sonraki bağımsız ürün geliştirmesi olarak öneriliyor. |
| 16: ignored ayrımı | Ignored `!` kayıtları untracked `?` kayıtlarıyla birleşiyordu. | Bu dilimde tamamlandı. |
| 18: port probing | `endpoint-probe.ts` bir candidate için bind kontrolü yapıyor. | Transaction ve helper iletişimi birlikte incelenerek batch tasarlanmalı; bu dilimde değiştirilmedi. |
| 22–33: sunum/dağıtım | Bazı metadata ve doküman değişiklikleri zaten var. | Gerçek platform kanıtlarına göre güncellenmeli; Windows desteği doğrulanmadan sunumda tamamlanmış gösterilmemeli. |
| 34: docs parity | Hata kodları için parity testi vardı; komut/flag referansları için eşdeğer kontrol yoktu. | Bu dilimde eklendi; gerçek README hatası yakalandı. |
| 35: lifecycle parity | Removal, ranking, release ve event testleri farklı dosyalara dağılmış. | İlgili kabul kriterlerini testlerle eşleştirmek gerekiyor; tek bir başarılı testle başlık kapatılmamalı. |

## Uygulanan değişiklikler

1. **Ignored dosyalar ayrı raporlanıyor.** `counts.ignored`, `paths.ignored` ve `ignored`
   classification'ı eklendi. `GIT_IGNORED_CONTENT`, silme reddinde exit 3 döndürüyor.
   Eski `untracked` alanından tüm yerel veriyi toplayan tüketiciler artık iki alanı okumalı.
   JSON zarfı sürümü değişmedi; proje 0.x sözleşmesi içindeki bu semantik değişiklik changelog'da açık.
2. **Removal entegrasyonu korundu.** Yalnızca tamamı temizlenecek ephemeral kaynakların içinde kalan
   ignored blocker ertelenebiliyor. Kaynak dışındaki kullanıcı verisi korunuyor; cleanup sırasında
   oluşan yeni ignored dosyayı ikinci analiz yakalıyor. Symlink hedefi takip edilmiyor.
   `lstat` sırasında yalnızca ENOENT kaybolmuş dosya sayılıyor; diğer hatalarda analiz duruyor.
   Geçersiz UTF-8 içeren porcelain verisi, dosya kimliğini değiştirerek kaybolmuş sanmamak için
   `GIT_REPOSITORY_DEGRADED` ile reddediliyor; geçerli Unicode dosya adları korunuyor.
3. **Komut dokümanları test ediliyor.** README, CLI reference, Agent Skill ve `examples/` altındaki
   Markdown dosyalarında inline/fenced komut referansları gerçek Commander kayıtlarıyla
   karşılaştırılıyor. Komutlar çalıştırılmıyor. Bilinmeyen komut, alt komut ve option yakalanıyor.
   README'deki `wtm skill --install` hatası `wtm skill install` olarak düzeltildi.
4. **TODO tutarlılığı düzeltildi.** Madde 16 ve 34 kapatıldı; mevcut create testlerinin doğruladığı
   dört checklist satırı güncellendi. Release checklist başlığı, dosyanın başındaki kararla uyumlu
   şekilde `v0.2.0` oldu. Native platform ve yayın kriterleri açık kaldı.

## Doğrulama ve sınırlar

- Bun 1.3.14 ve Node 24.19.0 kullanıldı; lockfile değiştirilmedi.
- Ignored ayrımı testleri implementasyon öncesinde beklenen nedenle başarısız oldu; değişiklik
  sonrasında geçti. Parity testi, README hatası düzeltilmeden önce onu raporladı.
- Seçilen parser, Git analysis/removal, global excludes, protocol, CLI JSON/exit, ranking,
  create ve documentation testleri: **15 dosyada 135 başarılı, 0 başarısız**. İzin hatası testi root koşullarında güvenilir
  chmod üretilemediği için tek filesystem çağrısını izole Node process'inde değiştiriyor;
  Git, CLI ve dosyanın korunması gerçek olarak doğrulanıyor.
- `bun run lint`, `bun run typecheck` ve build içeren `bun run package:verify` başarılı.
- **Tam test paketi başarılı kabul edilmedi.** İlk denemede, üretim kodu değiştirilmeden önce
  registered removal, lease ve process supervisor testleri başarısızdı; tekrar eden süreç
  hataları nedeniyle tam koşu durduruldu. Ortam kontrolü bir Node child için `process.pid=14`,
  `/proc/14/stat=ENOENT`, `/proc/self/stat=181208 (MainThread)` verdi. PID namespace ile procfs
  görünürlüğü uyuşmuyor; WTM süreç kimliğini bu ortamda güvenilir biçimde doğrulayamıyor.
- `bun run test:e2e` registered removal adımlarında `GIT_REPOSITORY_DEGRADED` ile başarısız.
  `bun run test:perf`: 19 test başarılı, 2 başarısız; daemon kullanan ölçümler başarılı değil.
  Bu hatalar atlanmış veya test beklentileri gevşetilmiş değil. Native CI tekrar çalışmalı.
- macOS Gatekeeper, Windows native davranışı, Linux ARM64 ve gerçek npm publish bu çalışma
  ortamında doğrulanmadı. Bu değişiklik bir release onayı değildir.

## Önerilen sonraki geliştirme sırası

1. **Native CI doğrulaması:** Bu dalın Git analizi ve removal değişikliklerini normal Linux,
   macOS ve Windows runner'larında çalıştır. Mevcut Windows sorunlarını ayrı takip et.
2. **Madde 10, readiness:** Config şeması, template çözümleme, supervisor sonucu ve CLI
   `start --wait --timeout` tek bir sözleşmede tanımlansın. Timeout, erken process çıkışı,
   iptal ve tekrar start senaryoları kapsansın. HTTP/TCP ile process-liveness ayrımı açık olsun.
3. **Madde 7, disk tahmini:** Önce ölçüm semantiği ve I/O bütçesi, sonra ranking entegrasyonu.
4. **Madde 6, multi-repo create:** Feature identity, deterministik kilit sırası ve kalıcı
   recovery planı; kullanıcı verisini silebilecek kör rollback yapılmamalı.
5. **Platform/yayın kapanışı:** Windows ve Linux ARM64 kanıtlarıyla doküman/metadata eşleştirmesi,
   ardından Apple ve npm hesap erişimi gerektiren gerçek dağıtım kontrolleri.

P2 local domains, PR awareness, idle suspension ve TUI işleri bu temel doğrulamalardan sonra ele
alınmalı. Mevcut çalışan parçaları yeniden yazmak bu hedeflere katkı sağlamıyor.
