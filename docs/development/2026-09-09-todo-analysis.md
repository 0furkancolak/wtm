# WTM: TODO analizi ve ilk geliştirme dilimi

Tarih: 2026-09-09. İncelenen başlangıç commit'i: `2fbdd02b5abec90a79dc661dc9f069726cea9831`.
Sürüm hedefi: `v0.2.0`; mevcut paket sürümü `0.1.0-rc.1`.

**Devam oturumu güncellemesi:** `816fb11` ve `7962428` aynı çalışma kopyasında içerikleriyle
doğrulandı; eksik devir yoktu, başlangıç çalışma ağacı temizdi. Aşağıdaki ilk analiz ve
135 testlik sonuç önceki dilimin kaydıdır. Madde 45'in uygulaması ve bu oturumun bağımsız
doğrulama sonuçları dosyanın sonundaki **Ortak kuyruk uygulaması** bölümündedir.

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
| 10: readiness | `start` ve supervisor mevcut; task healthcheck config'i ve readiness sonucu henüz yok. | Madde 45'in ilk diliminden sonra ele alınacak. |
| 16: ignored ayrımı | Ignored `!` kayıtları untracked `?` kayıtlarıyla birleşiyordu. | Bu dilimde tamamlandı. |
| 18: port probing | `endpoint-probe.ts` bir candidate için bind kontrolü yapıyor. | Transaction ve helper iletişimi birlikte incelenerek batch tasarlanmalı; bu dilimde değiştirilmedi. |
| 22–33: sunum/dağıtım | Bazı metadata ve doküman değişiklikleri zaten var. | Gerçek platform kanıtlarına göre güncellenmeli; Windows desteği doğrulanmadan sunumda tamamlanmış gösterilmemeli. |
| 34: docs parity | Hata kodları için parity testi vardı; komut/flag referansları için eşdeğer kontrol yoktu. | Bu dilimde eklendi; gerçek README hatası yakalandı. |
| 35: lifecycle parity | Removal, ranking, release ve event testleri farklı dosyalara dağılmış. | İlgili kabul kriterlerini testlerle eşleştirmek gerekiyor; tek bir başarılı testle başlık kapatılmamalı. |
| 45, 19: ortak iş kuyruğu ve RAM | Devam diliminde CLI/protocol/state/daemon ve skill birlikte uygulandı; sabit eşzamanlılık varsayılanı 1. | Native iki CLI/süreç ağacı kanıtı, gerçek makine bellek ölçümü ve belleğe göre iş başlatma açık. |

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

## Yeni ihtiyaç: eşzamanlı AI oturumlarında RAM baskısı

**İlk planlama kaydı, 2026-09-09:** Claude/AI oturumları ağır komutlarını bir skill üzerinden WTM'ye
göndersin; WTM sırayla çalıştırırken AI bağımsız işlere devam etsin. Bu ihtiyaç `todo.md`
madde 45 olarak P1'e eklendi. O anda yalnızca planlama değişikliğiydi; aşağıdaki devam
bölümünde uygulama ve doğrulama durumu ayrıca kaydedildi.

Kod incelemesi: `packages/cli/src/commands/run.ts` içindeki `runForegroundTask`, task'ı
`spawn` ile başlatıp exit olayına kadar bekliyor ve stdio'yu CLI'a bağlıyor. `start.ts`
daemon'a runtime isteği gönderiyor. `packages/core/src/state/store.ts` managed process
kayıtları barındırıyor; ayrı bir kalıcı job kuyruğu ve iş kabul sözleşmesi tanımlamıyor.
Bu nedenle yalnızca skill değişikliği yetmez; CLI, protocol, state ve daemon birlikte gelişmeli.

İlk dilim için mevcut daemon/SQLite üzerinde, aynı host ve kullanıcıdaki bütün repoların
paylaştığı kalıcı FIFO kuyruk ve varsayılan tek ağır iş slotu öneriliyor. Taslak
`wtm run <task> --enqueue --json` kabulden sonra `jobId` döndürür; agent durum, log ve
sonucu daha sonra okur. Mevcut foreground kullanım korunur. Her AI'ın kendi semaforunu
tutması oturumlar arası yükü sınırlamaz; ek kuyruk servisi ise yerel araca gereksiz yük ekler.

Bu tasarım build/test/typecheck gibi alt süreçlerin aynı anda çalışmasından doğan bellek
baskısını azaltmayı hedefler. Kullanıcının yaşadığı yükün ne kadarının bu komutlardan geldiği
henüz ölçülmedi; ilk adım temsili iki oturumda bellek dağılımını çıkarmaktır.
Claude'un kendi süreçlerinin RAM tüketimini doğrudan sınırlamaz;
WTM dışında başlatılan işler de bu kuyruğa dahil olmaz. Bir task kendi içinde çok sayıda worker
açabilir; ikinci dilimde task ayarları, bellek tahmini ve host'ta bırakılacak pay birlikte
değerlendirilmeli. Kesin RAM sınırı ve tasarruf oranı ancak platform desteği/ölçümle söylenebilir.

Agent'ın devam edebilmesi doğrulamanın doğruluğunu bozmamalı: queued/running işin okuduğu
dosyaları değiştirmek yerine kod okuma, planlama veya başka worktree'de bağımsız çalışma
sürer. Kaynaklar değişirse sonuç geçersiz sayılabilir; yalnızca HEAD kontrolü yeterli değildir.
Başarılı kabul yanıtı testin geçtiği anlamına gelmez; son durum ve exit code ayrıca okunur.
İptal, daemon restart, removal yarışı, sınırlı log/state ve iki oturumlu bellek ölçümleri
madde 45'in kabul kriterlerine dahil edildi. Otomatik agent bildirimi ayrı entegrasyon dilimidir.

## İlk analizde önerilen geliştirme sırası

1. **Native CI doğrulaması:** Bu dalın Git analizi ve removal değişikliklerini normal Linux,
   macOS ve Windows runner'larında çalıştır. Mevcut Windows sorunlarını ayrı takip et.
2. **Madde 45, ortak ağır iş kuyruğu:** Kalıcı job/IPC sözleşmesi, atomik slot yönetimi,
   hemen dönen CLI ve agent skill akışı. İlk dilimde sabit eşzamanlılık sınırı; sonra bellek
   farkındalığı. Native process doğrulaması gerekir; yayın hesabı işleri bunu bloke etmez.
3. **Madde 10, readiness:** Config şeması, template çözümleme, supervisor sonucu ve CLI
   `start --wait --timeout` tek bir sözleşmede tanımlansın. Timeout, erken process çıkışı,
   iptal ve tekrar start senaryoları kapsansın. HTTP/TCP ile process-liveness ayrımı açık olsun.
4. **Madde 7, disk tahmini:** Önce ölçüm semantiği ve I/O bütçesi, sonra ranking entegrasyonu.
5. **Madde 6, multi-repo create:** Feature identity, deterministik kilit sırası ve kalıcı
   recovery planı; kullanıcı verisini silebilecek kör rollback yapılmamalı.
6. **Platform/yayın kapanışı:** Windows ve Linux ARM64 kanıtlarıyla doküman/metadata eşleştirmesi,
   ardından Apple ve npm hesap erişimi gerektiren gerçek dağıtım kontrolleri.

P2 local domains, PR awareness, idle suspension ve TUI işleri bu temel doğrulamalardan sonra ele
alınmalı. Mevcut çalışan parçaları yeniden yazmak bu hedeflere katkı sağlamıyor.

## Ortak kuyruk uygulaması — devam oturumu

Çalışma dalı `codex/todo-safety-docs-parity`; devirdeki iki commit doğrulandı. Kullanıcının
son takip mesajı bu geliştirme dalına commit ve push yetkisi verdi. PR, merge ve release
yapılmadı. Git'te mevcut `user.name`/`user.email` korundu; coauthor satırı eklenmedi.

### Uygulanan sözleşme ve güvenlik

- **Tek scheduler:** Migration 012, mevcut SQLite ve daemon üzerinde FIFO job state ekler.
  Daemon global config'inde `[jobs].max_concurrent_heavy` varsayılan 1, aralık 1–64;
  repo override'ı bu limiti büyütemez. `queue=true`, `background!=true`, pozitif ve en fazla
  24 saat timeout gereklidir. `run` foreground ve `start` servis davranışı korunur.
- **Kapsam:** Aynı makine kimliği, UID/SID ve state veritabanı. Makine/kullanıcı kimliği
  uygulamaya özel digest olarak saklanır; yabancı kimlik, managed process recovery'den önce
  reddedilir. Ayrı state dizinleri ayrı limitlerdir. İlk legacy geçişinde eski host-local
  varsayımı devralınır; kayıtlara geriye dönük host kanıtı uydurulmaz.
- **Kabul ve sonuç ayrıdır:** `run --enqueue` kaynak/config ön kontrolünden ve kalıcı SQLite
  kabulünden sonra `jobId`, `state`, `accepted`, `idempotencyKey`, `reused` döndürür. Task
  bitişini beklemez. Retry için aynı anahtar; farklı kaynak/task fingerprint'i çatışmadır.
  İdempotency garantisi geçmiş kaydı tutulduğu süre içindir. JSON zarfı sürüm 1 korunur.
- **Atomiklik:** SQLite IMMEDIATE transaction admission, claim ve repository lease kontrolünü
  birbirini dışlayacak şekilde yürütür. Aynı worktree'de iki job başlamaz. FIFO'nun başındaki
  meşgul worktree arkadaki işleri bekletir. Pending/held job varken repository remove/GC/forget
  reddedilir; önce explicit cancel ve cleanup doğrulaması gerekir.
- **Süreç sahipliği:** Anchor PID ve managed record GO'dan önce kalıcı bağlanır. Başlatma sonucu
  veya süreç kimliği belirsizse slot tutulur. Restart sonucu belirsiz komutu yeniden başlatmaz.
  Completion marker numeric exit code, signal ve timeout kanıtını korur. Timeout anchor'da da
  uygulanır; daemon kapalıyken de deadline sürer. GO ve log hazırlığı sonunda deadline geçmişse
  child hiç spawn edilmez. Slot ancak süreç grubunun yokluğu doğrulanınca bırakılır.
- **Kaynak kanıtı:** HEAD, index, tracked/untracked içerik ve inode/mode/mtime/ctime/ancestor
  metadata hash'lenir. Ön kontrol, başlatma, tamamlanma ve sonuç okuma kaynak durumunu denetler.
  Limitler 10.000 dosya, 64 MiB içerik, 4 saniye, Git çıktısı başına 4 MiB; içerik 64 KiB
  buffer ile okunur. Symlink/submodule ve inceleme hatası fail-closed. Ignored/external girdiler
  kapsam dışıdır; bu atomik filesystem snapshot değildir ve geçici oluştur/sil işlemi kaçabilir.
  Büyük repo bu ilk dilimde güvenli biçimde reddedilebilir; HEAD eşitliği tek başına kanıt sayılmaz.
- **Sınırlı saklama:** En fazla 128 pending/held iş, terminal geçmiş hedefi 256 ve 7 gün,
  toplam sert kayıt sınırı 384. Prune enqueue sırasında; sonlandırılamayan cleanup sahipliği
  otomatik silinmez. Stream başına 1 MiB log + bir arşiv; sorgu stream başına 32 KiB.
  List çıktısı 128 KiB ve en fazla 100 iş; aynı anda en fazla iki admission ön kontrolü.
  Boş kuyruk için sürekli timer veya bellek taraması eklenmedi.
- **Agent akışı:** Skill enqueue → jobId saklama → okuma/planlama/başka worktree → seyrek status/log
  → terminal state + exitCode 0 + signal null + boşaltılmış slot + UNCHANGED kaynak sonucu
  doğrulamasını anlatır. CLI ayrıca yanıt iş kimliğini ve retry anahtarını istekle eşleştirir.
  Shell interception veya agent'ı kendiliğinden uyandırma iddiası yoktur.

### Bağımsız review ve giderilen bulgular

İlk iki subagent state/daemon ile CLI/skill sahipliklerini paylaştı; ağır kontroller yalnız ana
agent tarafından seri yürütüldü. CLI agent son review sırasında kullanım kotasına takılınca
ayrı bir reviewer görevlendirildi; aynı anda aktif agent sayısı ikiyi aşmadı.

Review ile ancestor symlink yarışı, Git output-limit kill timer'ı, IPC schemaVersion uyumsuzluğu,
başarısız süreç cleanup'ında sahiplik kaybı, pre-handshake anchor sahipliği, gecikmiş completion'ın
yanlış timeout olması, host guard'ının recovery sırası, legacy upgrade'da daemon'ı başlatmayı
engelleyen kilitlenme ve CLI signal/response identity kanıtları düzeltildi. Son review GO sırasında
deadline aşılması ve exit/stdio olay sırasının timeout sonucunu kaybettirmesini ayrıca ele aldı.
Tam testte bulunan gerçek SEA migration registry regresyonu düzeltildi; kaynak asset'leriyle
birebir byte-order karşılaştırması korunarak migration 012 beklentisi eklendi.

Son bağımsız kapanış review'inde incelenen kapsamda açık P1/P2 kalmadı. Local implementation
commit'leri: `22a38fe`, `e02ce15`, `b3e89f4`, `e40d417`, `02dfaa4`, `9a30d05`; ilk ilerleme
kaydı `5541fb8`. İlk `git push -u origin codex/todo-safety-docs-parity` denemesi
`could not read Username for 'https://github.com': No such device or address` ile reddedildi.
Terminalde Git credential helper yoktu. Bağlı GitHub hesabı `0furkancolak` olarak doğrulandı;
sunulan commit oluşturma API'si author/committer alanlarını veya mevcut yerel Git nesnelerini
yüklemeyi desteklemediği için ilk aşamada geçmiş değiştirilmedi.

Kullanıcı daha sonra “Bağlı GitHub hesabımla gönder” diyerek commit SHA ve
author/committer metadata değişikliğini açıkça yetkilendirdi. Bunun üzerine önceki iki devir
commit'i ve bu oturumun sekiz commit'i bağlı hesapla GitHub Git Data API üzerinden sırayla
yeniden oluşturuldu. Her commit'in Git tree SHA değeri yerel karşılığıyla birebir eşleşti:
dosya içerikleri, yolları ve modları korunuyor. Commit mesajları korundu; yeni coauthor
eklenmedi. Ortak başlangıç commit'i `2fbdd02b5abec90a79dc661dc9f069726cea9831`;
hedef geliştirme dalı `codex/todo-safety-docs-parity`. Yeni metadata nedeniyle SHA
üzerinden devir kontrolü yapan sonraki oturumlar aşağıdaki eşlemeyi kullanmalıdır.

| Önceki yerel commit | Bağlı hesapla oluşturulan GitHub commit'i |
| --- | --- |
| `816fb113998cff2f807f624c877ae097f2aa908a` | `6fff01922ff74daca23b746bced9ad2f0170f2b1` |
| `7962428cc27769c9b7f0500ccd9d269415233062` | `68d0ef2819bef25a6596ec2324bb2676bc83e1a6` |
| `22a38fe8ae068608a1d0c696e839882ed41f931b` | `5f5e91d997303504db13d586608bc2d926477f0c` |
| `e02ce1519118af4a4de848001d057af615a56ec4` | `10b087680c612c5d1820c06d75e36051ec8ce80a` |
| `b3e89f4f274ca732d637c6a39afd4ed9917495c3` | `b8af25aa684ddac3738d12ead11c57eb0d227d76` |
| `e40d417b64ce79c6815b543a93e0f9cda090f618` | `5c9887ecc60a8980380932445dde9da4acac276b` |
| `02dfaa4ba40c8bcfcd6f349838b4310a8e4d00aa` | `9435c279bb673a5f128db11f6db6693906db703b` |
| `9a30d0560ecd6f24a347bc8434e39d8edfc961d1` | `1afe5722c2777db326ed1f65334c4c66cfebd70d` |
| `5541fb8bed0c4855d3b460b42fb25b034b3fcc50` | `6cf195e804603768a38349097f69887c2b0d02d9` |
| `1e1a869dfe9384c971cbb3e9f3f5d549f243eb3c` | `a456e4f40105e05e4ab8892395f0adfbc705355f` |

Bu yayın kaydı, yukarıdaki on commit'ten sonra ayrı bir doküman commit'i olarak eklenir.
Bu işlemde ürün kodu veya test beklentileri değiştirilmedi; aşağıdaki doğrulama sonuçları
ve açık native platform/RAM kanıtları geçerliliğini korur. GitHub dalına gönderme izni,
PR açma, merge veya registry release izni anlamına gelmez.

### Bu ortamın sınırları ve sonraki iş

Son doğrulama kaydı (Bun 1.3.14, Node 24.19.0; komutlar seri çalıştırıldı):

| Kontrol | Sonuç ve sınır |
| --- | --- |
| Başlangıç `bun run test` | Kod değişmeden 420 pass / 49 fail kaydı; tamamlanmadı, durduruldu. Önceki oturumun yeşil sonucu devralınmadı. |
| Önceki güvenlik ve docs parity seçimi | 16 dosyada 137 pass / 0 fail; ignored/untracked, geçersiz UTF-8, inceleme hatası, removal guard, create ve protocol kapsamı. |
| Yeni protocol/config/source kanıtı | 6 dosyada 17 pass / 0 fail. Ancestor değiştir/geri koy yarışı ayrıca izole Node senaryosuyla testli. |
| Host/user kapsamı | 3 fixture testi pass; bu host'ta gerçek Linux kimlik okuyucu da değer üretti. macOS/Windows native kanıtı değildir. |
| Son state/daemon/anchor seçimi | 3 dosyada 7 pass / 0 fail. Gerçek SQLite child süreçleri, restart/timeout/cancel/source ve GO deadline kapsamı; scheduler süreç sınırı kontrollü. |
| Log ve supervisor güvenlik ekleri | Private completion/log testi pass; transient cleanup ve rejected anchor ownership için 2 supervisor testi pass. |
| CLI dahil kuyruk seçimi | 15 pass / 1 fail. Başarısız test production CLI socket açma aşamasında; retry/signal/response identity testleri pass. |
| Migration/SEA asset kontrolleri | Gerçek registry regresyonu giderildikten sonra 15 pass / 0 fail; byte-order ve asset kaynağı karşılaştırması korunuyor. |
| `bun run lint` | Başarılı. |
| `bun run typecheck` | Son timeout düzeltmeleri dahil başarılı. |
| `bun run test` | 300 saniye dış sınırında exit 124; 440 pass / 81 fail / 11 mevcut skip kaydı. Bu tamamlanmış bir test özeti değildir. İçindeki 12 SEA failure daha sonra yukarıdaki hedefli kontrolle düzeltildi; tüm paket yeniden yeşil sayılmadı. |
| `bun run test:e2e` | 0 pass / 2 fail: önceki registered removal `GIT_REPOSITORY_DEGRADED`; yeni iki gerçek CLI/iki repo senaryosu `listen EPERM`. |
| `bun run test:perf` | 19 pass / 2 fail; production daemon socket kullanan ölçümler `listen EPERM`, nihai performans raporu başarılı üretilmedi. |
| `bun run package:verify` | Build ve npm dry-run başarılı; 65 dosya. CLI bundle içindeki migration 012 ve dağıtılan skill mevcut. Dry-run registry publish değildir. |

Tablodaki hedefli gruplar örtüşebilir; test sayıları toplanarak ayrı test sayısı çıkarılmamalı.
Tam koşudaki her hata otomatik ortam hatası sayılmadı: yeni SEA mismatch gerçek regresyondu ve
düzeltildi; süreç/socket hataları taze doğrudan probe'larla incelendi. Test beklentileri
gevşetilmedi, yeni skip eklenmedi. Son küçük düzeltmeler hedefli olarak doğrulandı; tam suite'in
native süreç koşulları bu ortamda karşılanamadığı için release doğrulaması tamamlanmış değil.

Kullanıcının gerçek Claude/Codex makinesine erişim yok. Yerel `ps` komutu `fatal library error,
lookup self` verdi; taze Node probe'unda PID 2 ile `/proc/self/stat` PID 257572 uyuşmadı.
Minimal Node Unix listener ve yeni production queue E2E doğrudan `listen EPERM` verdi. Bunlar
bu yürütme ortamının kanıtıdır; kullanıcının Mac RAM tüketimi hakkında kanıt değildir.

Gerçek iki oturumlu önce/sonra ölçümü
`2026-09-09-heavy-job-memory-measurement.md` içinde tekrarlanabilir şekilde tarif edildi.
Tepe bellek/swap/baskı, toplam süre, daemon ek maliyeti ve task worker sayısı beraber ölçülmeden
RAM tasarruf oranı söylenemez. Sabit eşzamanlılık, sert bellek üst sınırı değildir.

Madde 45 bütünü kapatılmadı. Sıradaki işler: normal Linux/macOS runner'da gerçek socket ve
süreç ağacı, daemon kapalıyken timeout/restart kanıtı; kullanıcının iki AI oturumunda ölçüm;
sonra kullanılabilir bellek, task tahmini, diğer uygulamalara bırakılan pay ve task'ın worker
paralelliğini birlikte kullanan RAM dilimi. Otomatik agent bildirimi ayrı entegrasyondur.
Readiness (madde 10) sonraki ürün önceliği olarak kalır; native veya RAM kriteri tamamlanmış
gösterilerek başka başlık kapatılmaz. macOS/Windows/Linux ARM64 kanıtları ve registry release erişimi açık.

## Devam dilimi: native CI düzeltmeleri ve kuyruk bekleme nedenleri

Başlangıç: GitHub'daki `e79b625` ile temiz ve eşit yerel dal. İlk hedefli
protocol/config/state/daemon kontrolü 4 dosyada 9 pass / 0 fail verdi. Önceki doğrulama
sınırları devralınmadan yeniden ölçüldü: Node 24.19.0 `process.pid=5` bildirirken
`/proc/self/stat` PID 384210 verdi; yeni Unix listener yine `EPERM` ile reddedildi.
Bu ortamdan kullanıcının Claude/Codex RAM tüketimine ilişkin sonuç çıkarılmadı.

Bağlı GitHub hesabıyla önceki gönderimin [CI koşusu](https://github.com/0furkancolak/wtm/actions/runs/34351667016)
ve gerçek job logları okundu. Linux x64 1464 pass / 5 fail, macOS ARM64 ve x64
1468 pass / 5 fail bildirdi. Üçünde de aynı beş hata vardı; bunlar ortam sorunu sayılmadı:

| Bulgu | Kök neden ve düzeltme |
| --- | --- |
| İki SQLite test hatası | Tam migration listesi 11'de kalmıştı; migration 012 eklenerek tam sıralı eşitlik korunuyor. |
| Kuyruk native senaryosu | `node -e` içindeki JavaScript parantezleri WTM argv template'i olarak okunuyordu. Program her repo'da kaynak fingerprint'ine dahil `queue-check.cjs` dosyasına taşındı; production resolver değiştirilmedi. İki CLI kabul isteği bitmeden fixture cleanup başlamıyor. |
| Ignored removal testi | Eski `GIT_UNTRACKED` beklentisi `GIT_IGNORED_CONTENT` sözleşmesine geçirildi; exact count/path ve içerik/topoloji koruma kontrolleri tutuldu. |
| GC stderr uyarısı | Gerçek FileHandle sızıntısı: resource guard'ın sandbox/parent inode pinleri kapatılmıyordu. Guard `close()` kazandı; üretim GC ve tek seferlik authorization `finally` içinde kapatıyor. Test fixture'ları da aynı sahipliği izliyor. |

GC kapanışı yeni kontrolleri hemen reddeder, kabul edilmiş kontroller bitene kadar pinleri
tutar, sonra tamamını kapatır. Yol/inode güvenliği korunur. İzole Node testi gerçek açık
FileHandle nesnelerini izler; eski üretim GC senaryosunda 7 açık descriptor yakaladı.
Başarısız kurulum/inspection yolunda yeni açılmış pinler de kapatılır. Bağımsız review'ın
bulduğu boş test başarısı riski giderildi: test hem gerçek descriptor açılmasını hem de
üretim dry-run/apply sonuçlarının başarıyla tamamlanmasını şart koşar.

Bağımsız inceleme ayrıca iptal/finalizasyon yarışını yeniden üretti: süreç exit 0 verdikten
sonra son kaynak kontrolü beklerken kabul edilen iptal, eski `SUCCEEDED` kararıyla ezilebiliyordu.
`finish()` aynı `BEGIN IMMEDIATE` içinde güncel `stopReason` okur; iptal, doğrulanmış timeout
ve interruption sırası korunur. Exit code/signal kaybolmaz; sonuç kalıcılaştıktan sonraki iptal
geçmişi yeniden yazmaz. Eski sürümün bırakmış olabileceği `SUCCEEDED` + non-null `stopReason`
kaydı da sonuç okurken başarı sayılmaz; daemon ve CLI bağımsız olarak reddeder.

Madde 45'in sonraki küçük ürün dilimi `waitingReason` oldu. Atomik claim ve salt okunur
tanı aynı karar fonksiyonunu kullanır: önce `concurrency`, sonra `fifo`, sonra
`worktree_busy`, aksi hâlde `dispatch_pending`. Aktif kayıt sayısı admission ile 128'e
sınırlı; tek SQL snapshot kullanılır. Yeni migration, dependency, scheduler veya sürekli
bellek taraması eklenmedi. `dispatch_pending` repository/source kontrollerinin geçtiği
anlamına gelmez. Running/terminal kayıtlar `null`; eski daemon alanı atlıyorsa sebep bilinmez.
README, CLI reference, architecture, changelog ve dağıtılan skill aynı sözleşmeyi anlatır.

İki subagent analiz/implementasyon ve çapraz review yaptı; dosya sahiplikleri devredilmeden
aynı dosyada paralel yazılmadı. Ağır kontroller yalnız ana agent tarafından sırayla yürütüldü.
İptal yarışının yeni testleri düzeltme öncesi 3 pass / 5 fail, guard lifecycle 0 pass / 4 fail,
native task fixture 0 pass / 1 fail, waiting state/daemon 0 pass / 2 fail verdi; beklenen
eksik davranışları yakaladıkları doğrulandı. Düzeltmelerden sonra ilgili 12 test, GC/state/
fixture grubundaki 89 test ve kuyruk integration grubundaki 19 test başarılı oldu. Gruplar
örtüştüğü için sayıları benzersiz test toplamı gibi toplanmamalı.

Madde 45 bütünü, RAM ölçümü ve RAM tabanlı admission açık kalır. Readiness/healthcheck için
mevcut kod incelendi: task probe'u yok, IPC isteği varsayılan 5 saniyede kesiliyor ve managed
PID uygulama yerine ownership anchor'ını gösteriyor. Sonraki HTTP/TCP readiness dilimi bu
sınırları birlikte ele almalı; yalnız PID canlılığından “servis hazır” sonucu çıkarmamalı.

Önceki koşunun Windows x64 sonucu 1167 pass / 199 mevcut skip / 107 fail oldu.
Bu platform yeşil veya destek doğrulaması tamamlanmış sayılmadı. Native log incelemesi,
completion marker açılırken yalnız `O_NOFOLLOW` ve descriptor sahibine güvenmenin Windows'ta
symlink'i reddetmediğini gösterdi. Yeni izole Node testi bu davranışı Linux'ta da yalnızca
ilgili open çağrısının `O_NOFOLLOW` bayrağını kaldırarak yeniden üretti: gerçek symlink,
geçici symlink ve dosya değişimi testleri 4 fail; normal okuma/rotation kontrolleri 2 pass.
Üretim düzeltmesi explicit lstat ve açık descriptor/path kimliği karşılaştırması kullanır.
Kaynak parent yarış fixture'ı Windows için `dir` türü belirtir; open ve restoration gerçekten
olmadan geçmez. Kaynak snapshot'ın güvenli ret davranışı değiştirilmedi.

Windows'un diğer hata kümeleri önceki kuyruk kodundan önce de vardı: private-directory
ownership, POSIX anchor mode kontrolü, `/usr/bin/git`, Unix socket/path ve signal varsayımları.
Bu bulgular madde 9'daki açık platform işine aittir; yeni güvenlik hatasını bunlara bağlayıp
görmezden gelmek için kullanılmadı.

Bu dilimin geniş yerel test koşusu 300 saniye dış sınırında exit 124 verdi: 459 pass,
69 fail, 11 mevcut skip satırı. Bağımsız inceleme 43 socket/IPC hazırlık hatası, 18 process
kimliği/anchor hatası, 6 fail-closed registered removal sonucu ve 2 blocked-marker timeout'u
ayırdı. 49 hata önceki yerel baseline'da da vardı. Aynı isimli 68 test, önceki head'in üç
Linux/macOS native logunda başarılıydı; kalan yeni CLI kuyruk senaryosu burada `listen EPERM`
ile daha erken durdu. Bu karşılaştırma yeni head'in native kanıtının yerine geçmez.
`test:e2e` 0 pass / 2 fail (`GIT_REPOSITORY_DEGRADED`, `listen EPERM`), `test:perf`
19 pass / 2 fail (production socket `EPERM`) verdi. Nihai performans raporu üretilmedi.

Son kuyruk/GC/protocol/CLI/docs parity seçimi 10 dosyada 45 pass / 1 fail verdi; tek hata
production CLI'ın gerçek socket açtığı mevcut testte `listen EPERM`. Yeni bekleme nedeni,
geçmiş çelişkili sonuç, iptal/finalizasyon, descriptor lifecycle ve docs parity kontrolleri
başarılı. Source snapshot grubu 5 pass / 0 fail verdi. Test atlanarak yeşil sonuç üretilmedi.

Log güvenliğinin bağımsız review'ı ek bir rotation yarışı buldu: anchor `.generation`
dosyasını atomik değiştirirken yeni inode kontrolü normal cursor okumasını kesebiliyordu.
İlk/son marker açılışı ve segment kayması için yeni testler 6 pass / 4 fail ile bunu yakaladı.
Cursor okumasında yalnız tanımlı identity conflict mevcut üç denemelik sınır içinde yeniden
denenir; completion/launch okuması aynı uyuşmazlığı kesin olarak reddeder. Sürekli marker
değişimi sonsuz retry yapmadan başarısız olur; symlink/unsafe target benign rotation sayılmaz.
Son log/completion/cursor grubu 3 dosyada 32 pass / 0 fail verdi. Bağımsız takip review'ı
rotation P2 bulgusunu kapattı; bu dilimde açık P1/P2 bulgusu kalmadı. Fake file-trust kullanan
taşınabilir saldırı senaryoları native Windows ACL doğrulamasının yerine geçmez.

Son üretim koduyla `bun run lint` ve `bun run typecheck` başarılı. `bun run package:verify`
build ve npm dry-run adımlarını başarıyla tamamladı (65 dosya); migration 012 ve güncel skill
pakette yer alıyor. Bu sonuç registry yayını veya tüm native gate'lerin yeşil olduğu anlamına
gelmez. Yukarıdaki tam test/e2e/performance sınırları korunur; sonraki GitHub gönderiminin
native CI sonucu ayrıca izlenmelidir. Bu dilim yerel commit'lere ayrıldı; GitHub'a gönderim
kullanıcının mevcut yetkisiyle bağlı hesap üzerinden, aynı dosya ağaçları korunarak yapılır.
